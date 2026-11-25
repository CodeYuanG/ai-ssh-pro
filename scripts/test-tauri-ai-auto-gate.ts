/**
 * Regression: the Tauri Core-A agent must honour the user's AI execution policy
 * (auto / ask / suggest) instead of hard-coding `policy: "ask"` and gating every
 * command behind Agree. Parity with the Electron main agent:
 *   - resolveAiPolicy + planCommandConfirm (risk badge alone never decides)
 *   - read-only caps to suggest; production high risk never silent-auto
 *   - consecutive auto-write streak forces one Agree
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const gate = readFileSync(join(root, 'src-tauri/src/ai_gate.rs'), 'utf8')
const agent = readFileSync(join(root, 'src-tauri/src/agent.rs'), 'utf8')
const ai = readFileSync(join(root, 'src-tauri/src/ai.rs'), 'utf8')
const bridge = readFileSync(join(root, 'src/renderer/src/tauri-bridge.ts'), 'utf8')

// Policy port is present and used.
assert.ok(/pub enum AiPolicy/.test(gate), 'ai_gate defines AiPolicy')
assert.ok(/pub fn resolve_policy\(/.test(gate), 'resolve_policy ported')
assert.ok(/pub fn decide_safety_gate\(/.test(gate), 'decide_safety_gate ported')
assert.ok(/pub fn classify_command\(/.test(gate), 'command classification ported')
assert.ok(gate.includes('"docker" | "podman" => is_docker_read(sub)'), 'docker ps is a read command')
assert.ok(gate.includes('should_force_confirm_after_auto_streak'), 'auto streak guard ported')

// Agent resolves the policy, reports it, and applies the gate before writing.
assert.ok(!/"policy": "ask"/.test(agent), 'progress no longer hard-codes ask')
assert.ok(agent.includes('"policy": resolved_policy.effective.as_str()'), 'progress reports the effective policy')
assert.ok(agent.includes('decide_safety_gate('), 'agent applies the safety gate')
assert.ok(agent.includes('SafetyMode::Auto'), 'agent has an auto-write path without Agree')
assert.ok(agent.includes('should_force_confirm_after_auto_streak(auto_write_streak, auto_streak_cap)'), 'agent enforces auto streak')
assert.ok(agent.includes('autoStreakCap'), 'agent emits streak info for the UI')
assert.ok(agent.includes('forcedConfirm'), 'agent flags a forced confirm')

// Payload/settings carry the context the gate needs.
assert.ok(/pub safety_context: Option<crate::ai_gate::SafetyContext>/.test(ai), 'chat payload carries safetyContext')
assert.ok(ai.includes('pub ai_policy: Option<String>'), 'settings carry aiPolicy')
assert.ok(ai.includes('pub ai_auto_high_risk: Option<bool>'), 'settings carry aiAutoHighRisk')
assert.ok(ai.includes('pub ai_auto_streak: Option<u32>'), 'settings carry aiAutoStreak')
assert.ok(bridge.includes('aiPolicy: s?.aiPolicy'), 'bridge exposes aiPolicy to the UI')
assert.ok(bridge.includes('aiAutoHighRisk: Boolean(s?.aiAutoHighRisk)'), 'bridge exposes aiAutoHighRisk')

// Partial settings must merge so toggling the policy never wipes providers/apiKey.
assert.ok(bridge.includes("path: ['ai'], value: { ...base, ...(s as object) }"), 'setSettings merges partial updates')

console.log('test-tauri-ai-auto-gate: OK')
