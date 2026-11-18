//! Minimal OpenClaw / Core-A style step agent (not full Electron memory stack).
//! Emits ai:stream step/confirm/exec events compatible with the existing UI.
use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::ai::{extract_json_object_pub, AiChatPayload, AiSettings};
use crate::ssh::SshManager;

type ConfirmEntry = (String, oneshot::Sender<bool>); // (run_id, tx)
type ConfirmMap = Arc<Mutex<HashMap<String, ConfirmEntry>>>;

fn resolve_tool_alias(raw: &str) -> String {
    match raw.trim() {
        "" => "get_terminal_snapshot".into(),
        "observe" | "memory_observe" => "memory_observe".into(),
        "list_threads" | "memory_list_threads" => "memory_list_threads".into(),
        "append_note" | "inventory_append_note" => "inventory_append_note".into(),
        "set_goal" | "memory_set_goal" => "memory_set_goal".into(),
        "archive_goal" | "memory_archive_goal" => "memory_archive_goal".into(),
        "get" | "inventory_get" => "inventory_get".into(),
        "search" | "inventory_search" => "inventory_search".into(),
        "context" | "inventory_context" => "inventory_context".into(),
        "snapshot" | "terminal_snapshot" | "get_terminal_snapshot" => "get_terminal_snapshot".into(),
        "memory_get" | "memory_context" => raw.trim().into(),
        other => other.to_string(),
    }
}

fn is_known_tool(name: &str) -> bool {
    matches!(
        name,
        "get_terminal_snapshot"
            | "inventory_search"
            | "inventory_get"
            | "inventory_context"
            | "inventory_append_note"
            | "memory_get"
            | "memory_context"
            | "memory_set_goal"
            | "memory_archive_goal"
            | "memory_observe"
            | "memory_list_threads"
    )
}

fn tool_label(tool: &str) -> &'static str {
    match tool {
        "get_terminal_snapshot" => "已自动读取终端快照",
        "inventory_search" => "正在检索主机档案",
        "inventory_get" | "inventory_context" => "正在读取主机档案",
        "inventory_append_note" => "正在写入主机备注",
        "memory_get" | "memory_context" => "正在读取会话记忆",
        "memory_set_goal" => "正在记录本轮目标",
        "memory_archive_goal" => "正在归档本轮目标",
        "memory_observe" => "正在写入观测记忆",
        "memory_list_threads" => "正在列出记忆线程",
        _ => "正在调用工具",
    }
}

/// Coerce model drift (action=tool name, missing description) into the UI step shape.
fn normalize_step_structured(mut parsed: Value, fallback: &str) -> Value {
    // Models sometimes put the tool name in `action` instead of action=tool_call.
    let raw_action = parsed
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !matches!(raw_action.as_str(), "tool_call" | "command" | "end" | "") {
        let as_tool = resolve_tool_alias(&raw_action);
        if is_known_tool(&as_tool) {
            if let Some(obj) = parsed.as_object_mut() {
                obj.insert("action".into(), json!("tool_call"));
                let has_tool = obj
                    .get("tool")
                    .or_else(|| obj.get("toolName"))
                    .or_else(|| obj.get("name"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some();
                if !has_tool {
                    obj.insert("tool".into(), json!(as_tool));
                }
            }
        }
    }

    let action = parsed
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("end")
        .to_string();
    let tool_raw = parsed
        .get("tool")
        .or_else(|| parsed.get("toolName"))
        .or_else(|| parsed.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let tool = if action == "tool_call" {
        resolve_tool_alias(tool_raw)
    } else {
        tool_raw.to_string()
    };

    let auto_fallback = if !fallback.trim().is_empty() {
        fallback.to_string()
    } else if action == "tool_call" {
        tool_label(&tool).to_string()
    } else if action == "command" {
        parsed
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("准备执行：{s}"))
            .unwrap_or_else(|| "准备执行命令".into())
    } else {
        "本轮结束".into()
    };

    let desc = parsed
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            parsed
                .get("message")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            parsed
                .get("summary")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(auto_fallback.as_str())
        .to_string();

    if let Some(obj) = parsed.as_object_mut() {
        obj.insert("description".into(), Value::String(desc));
        obj.remove("message");
        if action == "tool_call" {
            obj.insert("tool".into(), json!(tool.clone()));
            // Renderer historically checks `toolName` for snapshot strips.
            obj.insert("toolName".into(), json!(tool));
        }
    }
    parsed
}

pub struct AgentRuntime {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    confirms: ConfirmMap,
}

impl AgentRuntime {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            confirms: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn abort_all(&self) {
        let mut runs = self.runs.lock();
        for (_, flag) in runs.drain() {
            flag.store(true, Ordering::SeqCst);
        }
        let mut map = self.confirms.lock();
        for (_, (_, tx)) in map.drain() {
            let _ = tx.send(false);
        }
    }

    pub fn abort_run(&self, run_id: &str) -> bool {
        let mut found = false;
        if let Some(flag) = self.runs.lock().get(run_id) {
            flag.store(true, Ordering::SeqCst);
            found = true;
        }
        let mut map = self.confirms.lock();
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, (rid, _))| rid == run_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            if let Some((_, tx)) = map.remove(&id) {
                let _ = tx.send(false);
            }
        }
        found
    }

    /// Backward-compatible: abort every in-flight agent run.
    pub fn abort(&self) {
        self.abort_all();
    }

    pub fn resolve_confirm(&self, request_id: &str, ok: bool) -> bool {
        if let Some((_, tx)) = self.confirms.lock().remove(request_id) {
            let _ = tx.send(ok);
            true
        } else {
            false
        }
    }

    pub async fn run(
        &self,
        app: AppHandle,
        ssh: Arc<SshManager>,
        settings: AiSettings,
        payload: AiChatPayload,
    ) -> Result<()> {
        let run_id = crate::ai::resolve_run_id(&payload);
        let history_key = payload.history_key.clone();
        let abort = Arc::new(AtomicBool::new(false));
        self.runs.lock().insert(run_id.clone(), abort.clone());
        struct Guard<'a> {
            runs: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
            id: String,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.runs.lock().remove(&self.id);
            }
        }
        let _guard = Guard {
            runs: &self.runs,
            id: run_id.clone(),
        };
        let emit = |body: Value| {
            crate::ai::emit_ai_stream(&app, &run_id, history_key.as_deref(), body);
        };
        let provider = settings
            .providers
            .iter()
            .find(|p| p.id == settings.active_provider_id)
            .or_else(|| settings.providers.first())
            .cloned()
            .ok_or_else(|| anyhow!("未找到有效的 AI Provider 配置"))?;
        let api_key = provider.api_key.trim().to_string();
        if api_key.is_empty() {
            emit(json!({ "type": "error", "message": "请先填写 API Key（OpenClaw 风格核心会直接使用当前 Provider）。" }));
            return Ok(());
        }

        let max_steps = settings
            .ai_max_steps
            .filter(|n| *n >= 1 && *n <= 30)
            .unwrap_or(10) as usize;
        let url = format!(
            "{}/chat/completions",
            provider.base_url.trim_end_matches('/')
        );
        let temperature = settings
            .temperature
            .filter(|t| t.is_finite())
            .map(|t| t.clamp(0.0, 2.0))
            .unwrap_or(0.1);

        let mut messages: Vec<Value> = vec![json!({
            "role": "system",
            "content": SYSTEM_PROMPT
        })];
        for m in &payload.messages {
            messages.push(json!({ "role": m.role, "content": m.content }));
        }
        if let Some(ex) = payload
            .terminal_excerpt
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            messages.push(json!({
                "role": "user",
                "content": format!("【当前终端摘录】\n{}", ex.chars().rev().take(6000).collect::<String>().chars().rev().collect::<String>())
            }));
        }

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()?;

        emit(json!({ "type": "status", "text": "OpenClaw Core-A（Tauri 最小路径）运行中" }));

        for step in 1..=max_steps {
            if abort.load(Ordering::SeqCst) {
                emit(json!({ "type": "cancelled", "message": "aborted" }));
                return Ok(());
            }
            emit(json!({ "type": "progress", "step": step, "maxSteps": max_steps, "policy": "ask" }));

            let body = json!({
                "model": settings.model,
                "messages": messages,
                "temperature": temperature,
                "response_format": { "type": "json_object" }
            });
            let mut res = client
                .post(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .header("Content-Type", "application/json")
                .json(&body)
                .send()
                .await?;
            if !res.status().is_success() && res.status().as_u16() == 400 {
                let mut body2 = body.clone();
                if let Some(o) = body2.as_object_mut() {
                    o.remove("response_format");
                }
                res = client
                    .post(&url)
                    .header("Authorization", format!("Bearer {api_key}"))
                    .header("Content-Type", "application/json")
                    .json(&body2)
                    .send()
                    .await?;
            }
            if !res.status().is_success() {
                let status = res.status().as_u16();
                let t = res.text().await.unwrap_or_default();
                emit(json!({ "type": "error", "message": format!("HTTP {status}: {}", t.chars().take(200).collect::<String>()) }));
                return Ok(());
            }
            let json_body: Value = res.json().await?;
            let content = json_body
                .pointer("/choices/0/message/content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if content.is_empty() {
                emit(json!({ "type": "error", "message": "empty answer" }));
                return Ok(());
            }
            emit(json!({ "type": "delta", "text": content }));
            messages.push(json!({ "role": "assistant", "content": content }));

            let parsed = match extract_json_object_pub(&content) {
                Ok(v) => normalize_step_structured(v, ""),
                Err(_) => {
                    let fallback = content.chars().take(500).collect::<String>();
                    emit(json!({
                            "type": "step",
                            "structured": {
                                "action": "end",
                                "completed": true,
                                "description": fallback,
                                "riskLevel": "low",
                            }
                        }));
                    break;
                }
            };
            let action = parsed
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("end");
            if action == "end" {
                emit(json!({ "type": "step", "structured": parsed }));
                break;
            }

            if action == "tool_call" {
                let tool = resolve_tool_alias(
                    parsed
                        .get("tool")
                        .or_else(|| parsed.get("toolName"))
                        .or_else(|| parsed.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("get_terminal_snapshot"),
                );
                let args = parsed.get("args").cloned().unwrap_or(json!({}));
                emit(json!({ "type": "step", "structured": parsed }));
                let tool_result = match tool.as_str() {
                    "get_terminal_snapshot" => {
                        let snap = if let Some(sid) = &payload.target_session_id {
                            ssh.snapshot(sid, Some(12_000))
                                .await
                                .ok()
                                .flatten()
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                        snap.chars().rev().take(8000).collect::<String>().chars().rev().collect::<String>()
                    }
                    "inventory_search" => {
                        let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                        crate::inventory::search(q).to_string()
                    }
                    "inventory_get" => {
                        let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        match crate::inventory::get(id) {
                            Some(h) => serde_json::to_string_pretty(&h).unwrap_or_else(|_| "{}".into()),
                            None => "null".into(),
                        }
                    }
                    "inventory_context" => {
                        let id = args.get("id").and_then(|v| v.as_str());
                        let host = args.get("host").and_then(|v| v.as_str());
                        let port = args.get("port").and_then(|v| v.as_u64()).map(|p| p as u16);
                        crate::inventory::format_context(id, host, port)
                    }
                    "inventory_append_note" => {
                        let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let note = args.get("note").and_then(|v| v.as_str()).unwrap_or("");
                        match crate::inventory::append_note(id, note) {
                            Ok(h) => serde_json::to_string_pretty(&h).unwrap_or_else(|_| "{}".into()),
                            Err(e) => format!("error: {e}"),
                        }
                    }
                    "memory_get" => {
                        let key = args
                            .get("sessionKey")
                            .or_else(|| args.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        crate::core_memory::as_json(key).to_string()
                    }
                    "memory_context" => {
                        let key = args
                            .get("sessionKey")
                            .or_else(|| args.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        crate::core_memory::context_for_prompt(key)
                    }
                    "memory_set_goal" => {
                        let key = args
                            .get("sessionKey")
                            .or_else(|| args.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        let goal = args.get("goal").and_then(|v| v.as_str()).unwrap_or("");
                        crate::core_memory::set_working_goal(key, goal);
                        "ok".into()
                    }
                    "memory_archive_goal" => {
                        let key = args
                            .get("sessionKey")
                            .or_else(|| args.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        let goal = args
                            .get("goal")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| {
                                crate::core_memory::get_thread(key)
                                    .working_memory
                                    .map(|w| w.goal)
                                    .unwrap_or_default()
                            });
                        crate::core_memory::archive_goal(key, &goal);
                        "archived".into()
                    }
                    "memory_observe" => {
                        let key = args
                            .get("sessionKey")
                            .or_else(|| args.get("key"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("default");
                        let mut texts = Vec::new();
                        if let Some(arr) = args.get("texts").and_then(|v| v.as_array()) {
                            for v in arr {
                                if let Some(s) = v.as_str() {
                                    texts.push(s.to_string());
                                }
                            }
                        } else if let Some(s) = args.get("text").and_then(|v| v.as_str()) {
                            texts.push(s.to_string());
                        }
                        serde_json::to_string(&crate::core_memory::append_observations(key, texts))
                            .unwrap_or_else(|_| "[]".into())
                    }
                    "memory_list_threads" => crate::core_memory::list_threads().to_string(),
                    other => format!("unknown tool: {other}"),
                };
                messages.push(json!({
                    "role": "user",
                    "content": format!("【工具结果】\ntool={tool}\n{tool_result}")
                }));
                continue;
            }

            if action == "command" {
                let command = parsed
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .replace('\r', " ")
                    .replace('\n', " ");
                if command.is_empty() {
                    emit(json!({ "type": "error", "message": "command 为空" }));
                    return Ok(());
                }
                let request_id = Uuid::new_v4().to_string();
                let (tx, rx) = oneshot::channel();
                self.confirms.lock().insert(request_id.clone(), (run_id.clone(), tx));
                emit(json!({
                        "type": "step",
                        "requestId": request_id,
                        "safetyMode": "agree",
                        "structured": normalize_step_structured(parsed.clone(), &command)
                    }));
                let approved = rx.await.unwrap_or(false);
                self.confirms.lock().remove(&request_id);
                if !approved || abort.load(Ordering::SeqCst) {
                    emit(json!({ "type": "cancelled", "message": "user denied or aborted" }));
                    return Ok(());
                }
                let Some(sid) = payload.target_session_id.clone() else {
                    emit(json!({ "type": "error", "message": "未关联 SSH 会话，无法执行命令" }));
                    return Ok(());
                };
                // Match Electron: write into the live interactive PTY so the command
                // appears in the middle SSH terminal (not a side-channel exec).
                let started = std::time::Instant::now();
                let at = chrono::Utc::now().timestamp_millis();
                let write_ok = match ssh.write(&sid, format!("{command}\n")).await {
                    Ok(ok) => ok,
                    Err(e) => {
                        emit(json!({
                                "type": "exec",
                                "requestId": request_id,
                                "command": command,
                                "payload": {
                                    "status": "failed",
                                    "at": at,
                                    "durationMs": 0,
                                    "failureKind": "write",
                                    "evidence": format!("write failed: {e:#}")
                                }
                            }));
                        messages.push(json!({
                            "role": "user",
                            "content": format!("【命令写入失败】\n$ {command}\n{e:#}")
                        }));
                        continue;
                    }
                };
                if !write_ok {
                    emit(json!({
                            "type": "exec",
                            "requestId": request_id,
                            "command": command,
                            "payload": {
                                "status": "failed",
                                "at": at,
                                "durationMs": 0,
                                "failureKind": "write",
                                "evidence": "write returned false"
                            }
                        }));
                    messages.push(json!({
                        "role": "user",
                        "content": format!("【命令写入失败】\n$ {command}")
                    }));
                    continue;
                }
                // Let the shell print output into the ring buffer before we snapshot.
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                let snap = ssh
                    .snapshot(&sid, Some(80_000))
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let (summary, output_lines) = summarize_pty_output(&snap, &command);
                let duration_ms = started.elapsed().as_millis() as u64;
                emit(json!({
                        "type": "exec",
                        "requestId": request_id,
                        "command": command,
                        "payload": {
                            // No exit-code capture on Tauri yet → "sent", not a guessed ok/failed.
                            "status": "sent",
                            "at": at,
                            "durationMs": duration_ms,
                            "noExit": "unsupported",
                            "summary": summary,
                            "outputLines": output_lines
                        }
                    }));
                let tail = if snap.chars().count() > 6000 {
                    snap.chars().rev().take(6000).collect::<String>().chars().rev().collect::<String>()
                } else {
                    snap.clone()
                };
                messages.push(json!({
                    "role": "user",
                    "content": format!(
                        "【命令已写入终端】\n$ {command}\ndurationMs={duration_ms}\n终端快照尾部：\n{tail}"
                    )
                }));
                continue;
            }

            emit(json!({ "type": "step", "structured": parsed }));
            break;
        }

        emit(json!({ "type": "done" }));
        Ok(())
    }
}

/// Rough port of `summarizeExecOutput`: drop the echoed command line + trailing prompt, keep a short tail.
fn summarize_pty_output(snap: &str, command: &str) -> (String, usize) {
    let lines: Vec<&str> = snap.lines().collect();
    let cmd = command.trim();
    let mut start = 0usize;
    if !cmd.is_empty() {
        for (i, line) in lines.iter().enumerate().rev() {
            if line.contains(cmd) {
                start = i + 1;
                break;
            }
        }
    }
    let mut out: Vec<&str> = lines[start..].to_vec();
    while out.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    if let Some(last) = out.last() {
        let t = last.trim();
        // Common prompt shapes: user@host:path#  or  $ / #
        if t.ends_with('#') || t.ends_with('$') || t.ends_with('>') {
            out.pop();
        }
    }
    while out.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    while out.first().map(|s| s.trim().is_empty()).unwrap_or(false) {
        out.remove(0);
    }
    let output_lines = out.len();
    let max_lines = 8usize;
    let joined = out
        .iter()
        .rev()
        .take(max_lines)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join("\n");
    let mut summary = joined;
    const MAX_CHARS: usize = 800;
    if summary.chars().count() > MAX_CHARS {
        let trimmed: String = summary.chars().rev().take(MAX_CHARS - 1).collect::<String>().chars().rev().collect();
        summary = format!("…{trimmed}");
    }
    (summary, output_lines)
}

const SYSTEM_PROMPT: &str = r#"你是运维/开发助手（OpenClaw Core-A 最小闭环）。每一轮只决定下一步，输出单个 JSON 对象，不要 Markdown：
{"action":"tool_call"|"command"|"end","tool":"...","args":{},"command":"...","description":"...","riskLevel":"low"|"medium"|"high","completed":false}
action 只能是 tool_call / command / end（不要把工具名放进 action）。
description 必填，用一句中文说明本步在做什么。
可用 tool：get_terminal_snapshot；inventory_search / inventory_get / inventory_context / inventory_append_note；memory_get / memory_context / memory_set_goal / memory_archive_goal / memory_observe / memory_list_threads。
规则：优先只读；高风险变更命令用 riskLevel=high；任务完成时先 memory_archive_goal 再 action=end 且 completed=true。用简体中文。"#;

pub type SharedAgent = Arc<AgentRuntime>;
