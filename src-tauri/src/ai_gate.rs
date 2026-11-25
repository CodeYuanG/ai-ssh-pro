//! Rust port of the renderer's AI safety policy (`src/shared/ai-policy.ts`,
//! `src/shared/safety-tier.ts`, `src/shared/ai-write-guard.ts`,
//! `src/shared/ai-run-control.ts`, `src/shared/command-risk.ts`).
//!
//! The Tauri Core-A agent (`agent.rs`) previously hard-coded `policy: "ask"` and
//! gated every command behind Agree, ignoring the user's auto-execution policy.
//! This module makes the Tauri path honour the same policy the Electron main
//! process uses, so low/medium-risk commands can auto-write under `auto` while
//! high-risk and read-only protections keep their guard rails.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

// ----------------------------- policy -----------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiPolicy {
    Suggest,
    Ask,
    Auto,
}

impl AiPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            AiPolicy::Suggest => "suggest",
            AiPolicy::Ask => "ask",
            AiPolicy::Auto => "auto",
        }
    }

}

pub fn migrate_ai_policy(v: Option<&str>) -> Option<AiPolicy> {
    match v.map(str::trim) {
        Some("suggest") | Some("observe") => Some(AiPolicy::Suggest),
        Some("auto") | Some("autopilot") => Some(AiPolicy::Auto),
        // M24: trusted was shown as 需确认, never silently widened to auto.
        Some("ask") | Some("confirm") | Some("trusted") => Some(AiPolicy::Ask),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyContext {
    pub production: Option<bool>,
    pub protection: Option<String>,
    pub elevated: Option<bool>,
    pub host_policy: Option<String>,
    pub temp_policy: Option<String>,
    pub host_id: Option<String>,
    pub host_name: Option<String>,
}

impl Default for SafetyContext {
    fn default() -> Self {
        Self {
            production: None,
            protection: None,
            elevated: None,
            host_policy: None,
            temp_policy: None,
            host_id: None,
            host_name: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtectionLevel {
    Normal,
    Production,
    Readonly,
}

impl ProtectionLevel {
    fn rank(self) -> u8 {
        match self {
            ProtectionLevel::Normal => 0,
            ProtectionLevel::Production => 1,
            ProtectionLevel::Readonly => 2,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct HostProtection {
    pub level: ProtectionLevel,
    pub elevated: bool,
}

impl Default for HostProtection {
    fn default() -> Self {
        Self {
            level: ProtectionLevel::Normal,
            elevated: false,
        }
    }
}

/// Effective level the AI is held to. Elevation lifts production to normal;
/// read-only always stays read-only.
pub fn ai_effective_level(p: HostProtection) -> ProtectionLevel {
    if p.level == ProtectionLevel::Readonly {
        return ProtectionLevel::Readonly;
    }
    if p.level == ProtectionLevel::Production && p.elevated {
        return ProtectionLevel::Normal;
    }
    p.level
}

/// Stricter of two protection reports; a missing report adds nothing.
pub fn stricter_protection(a: Option<HostProtection>, b: Option<HostProtection>) -> HostProtection {
    let rows: Vec<HostProtection> = [a, b].into_iter().flatten().collect();
    if rows.is_empty() {
        return HostProtection::default();
    }
    let mut level = ProtectionLevel::Normal;
    for r in &rows {
        if r.level.rank() > level.rank() {
            level = r.level;
        }
    }
    HostProtection {
        level,
        elevated: rows.iter().all(|r| r.elevated),
    }
}

pub fn protection_from_safety_context(ctx: &SafetyContext) -> Option<HostProtection> {
    match ctx.protection.as_deref() {
        Some("readonly") => Some(HostProtection { level: ProtectionLevel::Readonly, elevated: ctx.elevated.unwrap_or(false) }),
        Some("production") => Some(HostProtection { level: ProtectionLevel::Production, elevated: ctx.elevated.unwrap_or(false) }),
        Some("normal") => Some(HostProtection { level: ProtectionLevel::Normal, elevated: ctx.elevated.unwrap_or(false) }),
        _ if ctx.production == Some(true) => Some(HostProtection { level: ProtectionLevel::Production, elevated: ctx.elevated.unwrap_or(false) }),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedPolicy {
    pub effective: AiPolicy,
    pub auto_high_risk: bool,
    pub capped_by_readonly: bool,
}

/// Mirror of `resolveAiPolicy`: temp override > host policy > global, capped by read-only.
pub fn resolve_policy(
    global: AiPolicy,
    auto_high_risk_setting: bool,
    ctx: &SafetyContext,
    protection: HostProtection,
) -> ResolvedPolicy {
    let chosen = migrate_ai_policy(ctx.temp_policy.as_deref())
        .or_else(|| migrate_ai_policy(ctx.host_policy.as_deref()))
        .unwrap_or(global);
    let mut effective = chosen;
    let mut capped = false;
    if ai_effective_level(protection) == ProtectionLevel::Readonly && chosen != AiPolicy::Suggest {
        effective = AiPolicy::Suggest;
        capped = true;
    }
    let auto_high_risk = effective == AiPolicy::Auto && auto_high_risk_setting;
    ResolvedPolicy {
        effective,
        auto_high_risk,
        capped_by_readonly: capped,
    }
}

pub fn policy_tier(p: AiPolicy) -> &'static str {
    match p {
        AiPolicy::Suggest => "observe",
        AiPolicy::Auto => "autopilot",
        AiPolicy::Ask => "confirm",
    }
}

// --------------------------- command kinds -------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Read,
    Write,
    High,
    Interactive,
}

impl CommandKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandKind::Read => "read",
            CommandKind::Write => "write",
            CommandKind::High => "high",
            CommandKind::Interactive => "interactive",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafetyMode {
    Auto,
    Agree,
    Strong,
    Suggest,
    Hold,
}

impl SafetyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SafetyMode::Auto => "auto",
            SafetyMode::Agree => "agree",
            SafetyMode::Strong => "strong",
            SafetyMode::Suggest => "suggest",
            SafetyMode::Hold => "hold",
        }
    }
}

fn interactive_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:^|[;&|]\s*)(?:\bsudo(?:\s+-[\w-]+|\s+--\S+|\s+-u\s+\S+)*\s+)?(?:ncdu|htop|btop|atop|nmon|iotop|iftop|nmtui|nvim|vim|vi|nano|emacs|less|more|most|watch|man|tmux|screen|ranger|mc|top)\b").unwrap())
}

fn is_read_bin(bin: &str) -> bool {
    matches!(
        bin,
        "ls" | "ll" | "dir" | "cat" | "tac" | "head" | "df" | "du" | "free" | "uptime"
            | "pwd" | "whoami" | "id" | "uname" | "echo" | "ps"
            | "pgrep" | "pstree" | "grep" | "egrep" | "fgrep" | "wc" | "true" | "false"
            | "which" | "whereis" | "type" | "file" | "stat" | "readlink" | "realpath" | "basename"
            | "dirname" | "printenv" | "who" | "w" | "last" | "lastlog" | "lsblk" | "lscpu"
            | "lsmem" | "lsmod" | "lsusb" | "lspci" | "findmnt" | "dmidecode" | "vmstat" | "iostat"
            | "mpstat" | "lsof" | "ss" | "netstat" | "traceroute" | "tracepath"
            | "dig" | "host" | "getent" | "nproc" | "arch" | "lsb_release"
            | "cut" | "uniq" | "tr" | "column" | "nl" | "od" | "hexdump" | "sha256sum" | "md5sum"
    )
}

fn is_systemctl_read(sub: &str) -> bool {
    matches!(
        sub,
        "status" | "is-active" | "is-enabled" | "is-failed" | "show" | "list-units"
            | "list-unit-files" | "cat" | "help" | "--version"
    )
}

fn has_unverifiable_shell_syntax(command: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\r\n]|\$\(|`|<\(|>\(|\$\{[^}]*@P[^}]*\}").unwrap())
        .is_match(command)
}

fn has_arg(parts: &[&str], exact: &[&str], prefixes: &[&str]) -> bool {
    parts.iter().skip(1).any(|p| exact.contains(p) || prefixes.iter().any(|prefix| p.starts_with(prefix)))
}

fn is_git_read(parts: &[&str]) -> bool {
    let Some(sub) = parts.get(1).copied() else {
        return false;
    };
    match sub {
        "status" | "ls-files" | "rev-parse" | "describe" => true,
        "log" | "diff" | "show" => !has_arg(
            parts,
            &["--output", "--ext-diff", "--textconv"],
            &["--output="],
        ),
        "branch" => parts.iter().skip(2).all(|p| {
            matches!(
                *p,
                "--list" | "-l" | "--all" | "-a" | "--remotes" | "-r" | "--verbose" | "-v" | "--show-current"
            )
        }),
        "remote" => {
            parts.len() == 2
                || (parts.len() == 3 && matches!(parts[2], "-v" | "--verbose"))
        }
        _ => false,
    }
}

fn docker_logs_follow(parts: &[&str]) -> bool {
    has_arg(parts, &["--follow"], &["--follow=", "-f"])
}

fn is_docker_read(parts: &[&str]) -> bool {
    let sub = parts.get(1).copied().unwrap_or("");
    match sub {
        "ps" | "images" | "inspect" | "version" | "info" => true,
        "logs" => !docker_logs_follow(parts),
        "image" => matches!(parts.get(2).copied(), Some("ls" | "inspect" | "history")),
        "container" => {
            let action = parts.get(2).copied().unwrap_or("");
            if matches!(action, "ls" | "inspect" | "top" | "port" | "diff") {
                true
            } else if action == "logs" {
                !docker_logs_follow(parts)
            } else {
                action == "stats" && parts.contains(&"--no-stream")
            }
        }
        _ => false,
    }
}

fn is_ip_read(parts: &[&str]) -> bool {
    let mut i = 1;
    while let Some(p) = parts.get(i).copied() {
        if !p.starts_with('-') {
            break;
        }
        if !matches!(
            p,
            "-4" | "-6" | "-o" | "-s" | "-b" | "-br" | "-oneline" | "-brief" | "-stats" | "-statistics"
        ) {
            return false;
        }
        i += 1;
    }
    let object = parts.get(i).copied().unwrap_or("");
    if !matches!(object, "addr" | "address" | "link" | "route" | "rule" | "neigh" | "maddress") {
        return false;
    }
    match parts.get(i + 1).copied() {
        None => true,
        Some("show" | "list") => true,
        Some("get") => matches!(object, "route" | "neigh"),
        _ => false,
    }
}

fn is_ifconfig_read(parts: &[&str]) -> bool {
    let mut interfaces = 0;
    for p in parts.iter().skip(1) {
        if p.starts_with('-') {
            if !matches!(*p, "-a" | "-s" | "-v" | "--all" | "--verbose") {
                return false;
            }
        } else {
            interfaces += 1;
        }
    }
    interfaces <= 1
}

fn is_mount_read(parts: &[&str]) -> bool {
    parts.iter().skip(1).all(|p| matches!(*p, "-l" | "--show-labels" | "-v" | "--verbose"))
}

fn is_swapon_read(parts: &[&str]) -> bool {
    parts.iter().skip(1).all(|p| matches!(*p, "--show" | "-s" | "--bytes" | "--noheadings" | "--raw"))
}

fn is_hostname_read(parts: &[&str]) -> bool {
    parts.iter().skip(1).all(|p| {
        matches!(
            *p,
            "-I" | "-i" | "-s" | "-f" | "-d" | "-a" | "-A" | "-y" | "--help" | "--version"
        )
    })
}

fn is_hostnamectl_read(parts: &[&str]) -> bool {
    match parts.get(1).copied() {
        None => true,
        Some(sub) => parts.len() == 2 && matches!(sub, "status" | "--help" | "--version"),
    }
}

fn is_timedatectl_read(parts: &[&str]) -> bool {
    match parts.get(1).copied() {
        None => true,
        Some(sub) => parts.len() == 2 && matches!(
            sub,
            "status" | "show" | "list-timezones" | "timesync-status" | "show-timesync"
        ),
    }
}

fn is_localectl_read(parts: &[&str]) -> bool {
    match parts.get(1).copied() {
        None => true,
        Some(sub) => parts.len() == 2 && matches!(
            sub,
            "status" | "list-locales" | "list-keymaps" | "list-x11-keymap-models"
        ),
    }
}

fn is_loginctl_read(parts: &[&str]) -> bool {
    match parts.get(1).copied() {
        None => true,
        Some(sub) => matches!(
            sub,
            "list-sessions" | "list-users" | "user-status" | "session-status" | "show-user" | "show-session"
        ),
    }
}

fn is_journalctl_read(parts: &[&str]) -> bool {
    !has_arg(
        parts,
        &[
            "--rotate",
            "--flush",
            "--sync",
            "--update-catalog",
            "-f",
        ],
        &["--vacuum", "--relinquish-var", "--follow"],
    )
}

fn is_dmesg_read(parts: &[&str]) -> bool {
    !has_arg(
        parts,
        &["--clear", "-C", "-c", "--console-level", "--follow", "-w"],
        &["--console-level="],
    )
}

fn is_sed_read(parts: &[&str]) -> bool {
    let args = parts.iter().skip(1).copied().collect::<Vec<_>>();
    let Some(script_index) = args.iter().position(|p| !p.starts_with('-')) else {
        return false;
    };
    if !args[..script_index].iter().all(|p| {
        matches!(
            *p,
            "-n" | "--quiet" | "--silent" | "-E" | "-r" | "--regexp-extended" | "-nE" | "-En"
        )
    }) {
        return false;
    }
    if args[script_index + 1..].iter().any(|p| p.starts_with('-')) {
        return false;
    }
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let quoted = args[script_index];
    let script = if quoted.len() >= 2
        && ((quoted.starts_with('\'') && quoted.ends_with('\''))
            || (quoted.starts_with('"') && quoted.ends_with('"')))
    {
        &quoted[1..quoted.len() - 1]
    } else {
        quoted
    };
    script.contains('p')
        && SCRIPT
            .get_or_init(|| Regex::new(r"^[0-9,$%p;\s-]+$").unwrap())
            .is_match(script)
}

fn is_find_read(body: &str) -> bool {
    static WRITE_ACTIONS: OnceLock<Regex> = OnceLock::new();
    !WRITE_ACTIONS
        .get_or_init(|| Regex::new(r"\s-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint(?:0)?|fprintf)\b").unwrap())
        .is_match(body)
}

fn is_sort_read(parts: &[&str]) -> bool {
    !has_arg(
        parts,
        &["--output", "--compress-program", "--temporary-directory"],
        &["-o", "--output=", "--compress-program=", "-T", "--temporary-directory="],
    )
}

fn is_rg_read(parts: &[&str]) -> bool {
    !has_arg(parts, &["--pre", "--hostname-bin"], &["--pre=", "--hostname-bin="])
}

fn is_tail_read(parts: &[&str]) -> bool {
    !has_arg(parts, &[], &["-f", "-F", "--follow", "--retry"])
}

fn is_date_read(parts: &[&str]) -> bool {
    !has_arg(parts, &[], &["-s", "--set"])
}

fn is_printf_read(parts: &[&str]) -> bool {
    !has_arg(parts, &[], &["-v"])
}

fn is_sar_read(parts: &[&str]) -> bool {
    !has_arg(parts, &[], &["-o"])
}

fn is_ping_read(parts: &[&str]) -> bool {
    !has_arg(
        parts,
        &[],
        &["-f", "-l", "-s", "-i", "--flood", "--preload", "--size", "--interval"],
    )
}

fn is_blkid_read(parts: &[&str]) -> bool {
    !has_arg(parts, &["-g"], &["--garbage-collect"])
}

fn strip_sudo(s: &str) -> String {
    let t = s.trim_start();
    let parts = t.split_whitespace().collect::<Vec<_>>();
    if parts.first().copied() != Some("sudo") {
        return t.to_string();
    }
    let mut i = 1;
    while i < parts.len() {
        let p = parts[i];
        if matches!(p, "-u" | "-g" | "--user" | "--group") {
            i += 2;
            continue;
        }
        if p.starts_with('-') {
            i += 1;
            continue;
        }
        break;
    }
    if i >= parts.len() {
        return t.to_string();
    }
    parts[i..].join(" ")
}

fn redirect_is_write(segment: &str) -> bool {
    let re = Regex::new(r"(^|[^<])>>?\s*(\S+)").unwrap();
    for cap in re.captures_iter(segment) {
        let target = cap.get(2).map(|m| m.as_str()).unwrap_or("");
        if target.is_empty() || target.starts_with('&') {
            continue;
        }
        if target == "/dev/null" || target == "/dev/stdout" || target == "/dev/stderr" {
            continue;
        }
        return true;
    }
    let both = Regex::new(r">\s*&\s+(\S+)").unwrap();
    for cap in both.captures_iter(segment) {
        let target = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if !matches!(target, "/dev/null" | "/dev/stdout" | "/dev/stderr") {
            return true;
        }
    }
    segment.split_whitespace().any(|p| p == "tee" || p.ends_with("/tee"))
}

fn is_read_segment(segment: &str) -> bool {
    let body = strip_sudo(segment);
    if body.is_empty() {
        return true;
    }
    if redirect_is_write(&body) {
        return false;
    }
    let parts = body.split_whitespace().collect::<Vec<_>>();
    let bin = parts.first().copied().unwrap_or("");
    let sub = parts.get(1).copied().unwrap_or("");
    match bin {
        "systemctl" => is_systemctl_read(sub),
        "service" => sub == "status" || parts.get(2).copied() == Some("status"),
        "git" => is_git_read(&parts),
        "docker" | "podman" => is_docker_read(&parts),
        "ip" => is_ip_read(&parts),
        "ifconfig" => is_ifconfig_read(&parts),
        "mount" => is_mount_read(&parts),
        "swapon" => is_swapon_read(&parts),
        "hostname" => is_hostname_read(&parts),
        "hostnamectl" => is_hostnamectl_read(&parts),
        "timedatectl" => is_timedatectl_read(&parts),
        "localectl" => is_localectl_read(&parts),
        "loginctl" => is_loginctl_read(&parts),
        "journalctl" => is_journalctl_read(&parts),
        "dmesg" => is_dmesg_read(&parts),
        "tail" => is_tail_read(&parts),
        "date" => is_date_read(&parts),
        "printf" => is_printf_read(&parts),
        "sar" => is_sar_read(&parts),
        "ping" => is_ping_read(&parts),
        "blkid" => is_blkid_read(&parts),
        "sed" => is_sed_read(&parts),
        "find" => is_find_read(&body),
        "du" => !Regex::new(r"\s--delete\b").unwrap().is_match(&body),
        "sort" => is_sort_read(&parts),
        "rg" => is_rg_read(&parts),
        _ => is_read_bin(bin),
    }
}

fn split_segments(text: &str) -> Vec<String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();
        if escaped {
            current.push(ch);
            escaped = false;
            i += 1;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            current.push(ch);
            escaped = true;
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            current.push(ch);
            if ch == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            current.push(ch);
            i += 1;
            continue;
        }
        if (ch == '&' && next == Some('&')) || (ch == '|' && next == Some('|')) {
            segments.push(std::mem::take(&mut current));
            i += 2;
            continue;
        }
        if ch == ';'
            || ch == '|'
            || (ch == '&' && chars.get(i.saturating_sub(1)) != Some(&'>') && next != Some('>'))
        {
            segments.push(std::mem::take(&mut current));
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    segments.push(current);
    segments
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Match `dd ... of=/dev/<disk>` but not `/dev/null` or `/dev/zero`.
/// The JS source uses a negative look-ahead; Rust regex has none, so we capture
/// the device name and check it in code.
fn dd_writes_disk(command: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\bdd\b[^|;&]*\bof=(/dev/[A-Za-z0-9_-]+)").unwrap());
    re.captures_iter(command).any(|cap| {
        let dev = cap.get(1).map(|m| m.as_str()).unwrap_or("").to_ascii_lowercase();
        dev != "/dev/null" && dev != "/dev/zero"
    })
}

fn is_local_high(command: &str) -> bool {
    if assess_command_high(command) {
        return true;
    }
    static POWERS: OnceLock<Regex> = OnceLock::new();
    let powers = POWERS.get_or_init(|| Regex::new(r"(?i)(?:^|[;&|]\s*)(?:\bsudo(?:\s+\S+)*\s+)?(?:shutdown|reboot|halt|poweroff|init\s+[06])\b").unwrap());
    if powers.is_match(command) {
        return true;
    }
    static MKFS: OnceLock<Regex> = OnceLock::new();
    if MKFS.get_or_init(|| Regex::new(r"(?i)\bmkfs(?:\.\w+)?\b").unwrap()).is_match(command) {
        return true;
    }
    if dd_writes_disk(command) {
        return true;
    }
    static DEV: OnceLock<Regex> = OnceLock::new();
    DEV.get_or_init(|| Regex::new(r">\s*/dev/(?:sd[a-z]|nvme\d+|vd[a-z]|xvd[a-z]|hd[a-z])").unwrap())
        .is_match(command)
}

fn assess_command_high(command: &str) -> bool {
    let s = command.trim();
    if s.is_empty() {
        return false;
    }
    if dd_writes_disk(s) {
        return true;
    }
    static SYS_DIRS: &str = r"(?:/|/\*|~|~/|\$HOME|/(?:bin|boot|dev|etc|home|lib|lib64|opt|root|sbin|srv|usr|var)(?:/\*?)?)";
    static RULES: OnceLock<Vec<Regex>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        let patterns = [
            // No look-ahead in Rust regex; the trailing delimiter is matched but
            // not captured, which is equivalent for our purpose.
            format!(r"\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+|-[a-zA-Z]+\s+)*(?:--no-preserve-root\s+)?{}[\s;&|\]]", SYS_DIRS),
            r"\bmkfs(?:\.\w+)?\b".to_string(),
            r">\s*/dev/(?:sd[a-z]|nvme\d+|vd[a-z]|xvd[a-z]|hd[a-z])".to_string(),
            r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:".to_string(),
            r"(?:^|[;&|]\s*|\bsudo\s+)(?:shutdown|reboot|halt|poweroff|init\s+[06])\b".to_string(),
            r"\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)\S+\s+/(?:\s|$)".to_string(),
            r"(?i)\bdrop\s+(?:database|schema|table)\b".to_string(),
            r"(?i)\btruncate\s+table\b".to_string(),
            r"\biptables\s+(?:-F|--flush)\b|\bufw\s+reset\b|\bnft\s+flush\s+ruleset\b".to_string(),
            r"\bkill(?:all)?\s+-9\s+-1\b|\bpkill\s+-9\s+-u\b".to_string(),
        ];
        patterns
            .iter()
            .filter_map(|p| Regex::new(p).ok())
            .collect()
    });
    // Append a trailing space so rules that require a delimiter after a path
    // also match when the command ends with that path.
    let padded = format!("{} ", s);
    rules.iter().any(|re| re.is_match(&padded))
}

pub fn classify_command(command: &str, risk_level: Option<&str>) -> CommandKind {
    let text = command.trim();
    if text.is_empty() {
        return CommandKind::Write;
    }
    if has_unverifiable_shell_syntax(text) {
        return CommandKind::High;
    }
    if interactive_re().is_match(text) {
        return CommandKind::Interactive;
    }
    if risk_level == Some("high") || is_local_high(text) {
        return CommandKind::High;
    }
    let segments = split_segments(text);
    if segments.is_empty() {
        return CommandKind::Write;
    }
    if segments.iter().all(|s| is_read_segment(s)) {
        CommandKind::Read
    } else {
        CommandKind::Write
    }
}

// ------------------------- safety gate -----------------------------

fn mode_for(tier: &str, kind: CommandKind, allow_high_risk: bool, production: bool, held: bool) -> SafetyMode {
    match kind {
        CommandKind::Interactive => {
            if held {
                SafetyMode::Hold
            } else if tier == "observe" {
                SafetyMode::Suggest
            } else {
                SafetyMode::Agree
            }
        }
        CommandKind::High => {
            if tier == "autopilot" && allow_high_risk && !production {
                SafetyMode::Auto
            } else if tier == "observe" {
                SafetyMode::Suggest
            } else if tier == "confirm" {
                SafetyMode::Strong
            } else {
                SafetyMode::Agree
            }
        }
        CommandKind::Read => SafetyMode::Auto,
        CommandKind::Write => {
            if tier == "observe" {
                SafetyMode::Suggest
            } else if tier == "confirm" {
                SafetyMode::Agree
            } else {
                SafetyMode::Auto
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct SafetyDecision {
    pub mode: SafetyMode,
    pub kind: CommandKind,
}

pub fn decide_safety_gate(
    command: &str,
    risk_level: Option<&str>,
    resolved: &ResolvedPolicy,
    protection: HostProtection,
    held: bool,
) -> SafetyDecision {
    let kind = classify_command(command, risk_level);
    let tier = policy_tier(resolved.effective).to_string();
    // In the Tauri path no autopilot allow-list exists, so autopilot is always permitted.
    let applied = tier.clone();
    let mut mode = if command.trim().is_empty() {
        SafetyMode::Agree
    } else {
        mode_for(
            &applied,
            kind,
            resolved.auto_high_risk,
            // M25: production no longer caps the policy inside the gate; it is
            // applied separately by the H01 block below (matching Electron).
            false,
            held,
        )
    };
    // Read-only host: the AI never writes.
    if ai_effective_level(protection) == ProtectionLevel::Readonly {
        mode = SafetyMode::Suggest;
    }
    // H01 / blockSilentHighRiskOnProd: production never silently auto-runs high risk.
    if ai_effective_level(protection) == ProtectionLevel::Production
        && kind == CommandKind::High
        && mode == SafetyMode::Auto
    {
        mode = SafetyMode::Strong;
    }
    SafetyDecision { mode, kind }
}

// ------------------------- run control -----------------------------

pub const DEFAULT_MAX_STEPS: u32 = 10;
pub const DEFAULT_AUTO_STREAK: u32 = 5;

pub fn resolve_max_steps(value: Option<u32>) -> u32 {
    match value {
        Some(n) if (1..=30).contains(&n) => n,
        _ => DEFAULT_MAX_STEPS,
    }
}

pub fn resolve_auto_streak(value: Option<u32>) -> u32 {
    match value {
        Some(n) if (1..=30).contains(&n) => n,
        _ => DEFAULT_AUTO_STREAK,
    }
}

/// True when the next non-read auto candidate must wait for Agree.
pub fn should_force_confirm_after_auto_streak(streak: u32, cap: u32) -> bool {
    streak >= resolve_auto_streak(Some(cap))
}

/// Bump the streak only after an auto-written non-read command.
pub fn bump_auto_write_streak(streak: u32, kind: CommandKind) -> u32 {
    if kind == CommandKind::Read {
        streak
    } else {
        streak + 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct CommandFixture {
        version: u32,
        cases: Vec<CommandCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CommandCase {
        id: String,
        command: String,
        kind: String,
        risk_level: Option<String>,
    }

    fn fixture_kind(value: &str) -> CommandKind {
        match value {
            "read" => CommandKind::Read,
            "write" => CommandKind::Write,
            "high" => CommandKind::High,
            "interactive" => CommandKind::Interactive,
            _ => panic!("unknown command kind: {value}"),
        }
    }

    fn fixture_mode(policy: AiPolicy, kind: CommandKind) -> SafetyMode {
        match (policy, kind) {
            (_, CommandKind::Read) => SafetyMode::Auto,
            (AiPolicy::Suggest, _) => SafetyMode::Suggest,
            (AiPolicy::Ask, CommandKind::High) => SafetyMode::Strong,
            (AiPolicy::Ask, _) => SafetyMode::Agree,
            (AiPolicy::Auto, CommandKind::High | CommandKind::Interactive) => SafetyMode::Agree,
            (AiPolicy::Auto, CommandKind::Write) => SafetyMode::Auto,
        }
    }

    #[test]
    fn shared_command_fixture_matches_typescript_policy() {
        let fixture: CommandFixture = serde_json::from_str(include_str!(
            "../../tests/fixtures/ai-command-safety.json"
        ))
        .expect("valid shared command fixture");
        assert_eq!(fixture.version, 1);
        assert!(fixture.cases.len() >= 90);
        for row in fixture.cases {
            let risk = row.risk_level.as_deref().unwrap_or("medium");
            let expected_kind = fixture_kind(&row.kind);
            assert_eq!(
                classify_command(&row.command, Some(risk)),
                expected_kind,
                "{}: kind",
                row.id
            );
            for policy in [AiPolicy::Ask, AiPolicy::Auto, AiPolicy::Suggest] {
                let resolved = resolve_policy(
                    policy,
                    false,
                    &SafetyContext::default(),
                    HostProtection::default(),
                );
                let decision = decide_safety_gate(
                    &row.command,
                    Some(risk),
                    &resolved,
                    HostProtection::default(),
                    false,
                );
                assert_eq!(decision.kind, expected_kind, "{}: {policy:?} kind", row.id);
                assert_eq!(
                    decision.mode,
                    fixture_mode(policy, expected_kind),
                    "{}: {policy:?} mode",
                    row.id
                );
            }
        }
    }

    #[test]
    fn reads_are_read_kind() {
        assert_eq!(classify_command("docker ps -a --format '{{.ID}}'", None), CommandKind::Read);
        assert_eq!(classify_command("ls -la && cat /etc/hostname", None), CommandKind::Read);
        assert_eq!(classify_command("git status", None), CommandKind::Read);
        assert_eq!(classify_command("systemctl status sshd", None), CommandKind::Read);
    }

    #[test]
    fn writes_and_high_are_not_read() {
        assert_eq!(classify_command("rm -rf /tmp/build", None), CommandKind::Write);
        assert_eq!(classify_command("rm -rf /", None), CommandKind::High);
        assert_eq!(classify_command("reboot", None), CommandKind::High);
        assert_eq!(classify_command("mkfs.ext4 /dev/sda1", None), CommandKind::High);
    }

    #[test]
    fn interactive_never_auto() {
        assert_eq!(classify_command("top", None), CommandKind::Interactive);
        assert_eq!(classify_command("sudo vim /etc/hosts", None), CommandKind::Interactive);
    }

    #[test]
    fn auto_policy_reads_and_writes() {
        let ctx = SafetyContext::default();
        let p = resolve_policy(AiPolicy::Auto, false, &ctx, HostProtection::default());
        let d = decide_safety_gate("docker ps -a", None, &p, HostProtection::default(), false);
        assert_eq!(d.mode, SafetyMode::Auto);
        let d = decide_safety_gate("rm -rf /tmp/build", None, &p, HostProtection::default(), false);
        assert_eq!(d.mode, SafetyMode::Auto);
        let d = decide_safety_gate("rm -rf /", None, &p, HostProtection::default(), false);
        assert_eq!(d.mode, SafetyMode::Agree);
    }

    #[test]
    fn ask_policy_waits_for_write() {
        let ctx = SafetyContext::default();
        let p = resolve_policy(AiPolicy::Ask, false, &ctx, HostProtection::default());
        let d = decide_safety_gate("docker ps -a", None, &p, HostProtection::default(), false);
        assert_eq!(d.mode, SafetyMode::Auto);
        let d = decide_safety_gate("rm -rf /tmp/build", None, &p, HostProtection::default(), false);
        assert_eq!(d.mode, SafetyMode::Agree);
    }

    #[test]
    fn readonly_caps_all() {
        let ctx = SafetyContext::default();
        let p = resolve_policy(AiPolicy::Auto, true, &ctx, HostProtection { level: ProtectionLevel::Readonly, elevated: false });
        assert_eq!(p.effective, AiPolicy::Suggest);
        let d = decide_safety_gate("docker ps -a", None, &p, HostProtection { level: ProtectionLevel::Readonly, elevated: false }, false);
        assert_eq!(d.mode, SafetyMode::Suggest);
    }

    #[test]
    fn production_high_risk_forces_strong() {
        let ctx = SafetyContext::default();
        let prod = HostProtection { level: ProtectionLevel::Production, elevated: false };
        let p = resolve_policy(AiPolicy::Auto, true, &ctx, prod);
        let d = decide_safety_gate("rm -rf /", None, &p, prod, false);
        assert_eq!(d.mode, SafetyMode::Strong);
    }

    #[test]
    fn streak_rules() {
        assert!(!should_force_confirm_after_auto_streak(4, 5));
        assert!(should_force_confirm_after_auto_streak(5, 5));
        assert_eq!(bump_auto_write_streak(2, CommandKind::Read), 2);
        assert_eq!(bump_auto_write_streak(2, CommandKind::Write), 3);
    }
}
