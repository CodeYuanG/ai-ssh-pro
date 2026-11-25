/**
 * Agent safety tiers. Orthogonal to the low / medium / high risk badge:
 * the badge still labels a command, and the tier decides which labels skip Agree.
 * High risk does not auto-run unless autopilot is on and the high-risk switch
 * is explicitly enabled, and never on a production host.
 * Interactive tools (ncdu, top, vim, less, …) never auto-run. The same in-flight
 * command is not asked to Agree again.
 */
import { assessCommandRisk } from './command-risk'

export const SAFETY_TIERS = ['observe', 'confirm', 'trusted', 'autopilot'] as const

export type SafetyTier = (typeof SAFETY_TIERS)[number]

export const DEFAULT_SAFETY_TIER: SafetyTier = 'confirm'

export type SafetyMode = 'auto' | 'agree' | 'strong' | 'suggest' | 'hold'

export type CommandKind = 'read' | 'write' | 'high' | 'interactive'

export type SafetySettings = {
  safetyTier?: unknown
  safetyTierHosts?: Record<string, unknown> | null
  safetyTierSessions?: Record<string, unknown> | null
  autopilotAllowHosts?: readonly string[] | null
  autopilotAllowHighRisk?: boolean | null
  /** M21 policy fields (see ai-policy.ts). */
  aiPolicy?: unknown
  aiAutoHighRisk?: boolean | null
}

export type SafetyScope = {
  tier: SafetyTier
  command: string
  riskLevel?: string | null
  production?: boolean
  hostId?: string | null
  hostName?: string | null
  allowHosts?: readonly string[] | null
  allowHighRisk?: boolean
  book?: InFlightBook | null
}

export type SafetyDecision = {
  mode: SafetyMode
  kind: CommandKind
  tier: SafetyTier
  /** Tier whose rules ran. Autopilot falls back to confirm when it is not permitted. */
  appliedTier: SafetyTier
  warn: boolean
  alternative: string | null
  offerAgree: boolean
  strong: boolean
  /** Pre-approval: the command may be written without waiting. */
  write: boolean
  /** Pre-approval: the existing Agree / Decline path must run. */
  waitForAgree: boolean
}

const INTERACTIVE =
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-[\w-]+|\s+--\S+|\s+-u\s+\S+)*\s+)?(?:ncdu|htop|btop|atop|nmon|iotop|iftop|nmtui|nvim|vim|vi|nano|emacs|less|more|most|watch|man|tmux|screen|ranger|mc|top)\b/

const READ_BIN = new Set([
  'ls', 'll', 'dir', 'cat', 'tac', 'head', 'df', 'du', 'free', 'uptime', 'pwd', 'whoami', 'id',
  'uname', 'echo', 'ps', 'pgrep', 'pstree', 'grep', 'egrep', 'fgrep',
  'wc', 'true', 'false', 'which', 'whereis', 'type', 'file', 'stat', 'readlink', 'realpath', 'basename',
  'dirname', 'printenv', 'who', 'w', 'last', 'lastlog', 'lsblk', 'lscpu', 'lsmem', 'lsmod', 'lsusb',
  'lspci', 'findmnt', 'dmidecode', 'vmstat', 'iostat', 'mpstat', 'lsof', 'ss', 'netstat',
  'traceroute', 'tracepath', 'dig', 'host', 'getent', 'nproc', 'arch', 'lsb_release',
  'cut', 'uniq', 'tr', 'column', 'nl', 'od', 'hexdump', 'sha256sum', 'md5sum'
])

const SYSTEMCTL_READ = new Set([
  'status', 'is-active', 'is-enabled', 'is-failed', 'show', 'list-units', 'list-unit-files', 'cat', 'help', '--version'
])

function hasUnverifiableShellSyntax(command: string): boolean {
  return /[\r\n]/.test(command) || /\$\(|`|<\(|>\(|\$\{[^}]*@P[^}]*\}/.test(command)
}

function isGitRead(parts: string[]): boolean {
  const sub = parts[1]
  if (sub === 'status' || sub === 'ls-files' || sub === 'rev-parse' || sub === 'describe') return true
  if (sub === 'log' || sub === 'diff' || sub === 'show') {
    return !parts.some((p) => p === '--output' || p.startsWith('--output=') || p === '--ext-diff' || p === '--textconv')
  }
  if (sub === 'branch') {
    return parts.slice(2).every((p) => ['--list', '-l', '--all', '-a', '--remotes', '-r', '--verbose', '-v', '--show-current'].includes(p))
  }
  return sub === 'remote' && (parts.length === 2 || (parts.length === 3 && (parts[2] === '-v' || parts[2] === '--verbose')))
}

function isDockerRead(parts: string[]): boolean {
  const sub = parts[1]
  if (sub === 'ps' || sub === 'images' || sub === 'inspect' || sub === 'version' || sub === 'info') return true
  if (sub === 'logs') return !parts.some((p) => p === '--follow' || p.startsWith('--follow=') || p.startsWith('-f'))
  if (sub === 'image') return parts[2] === 'ls' || parts[2] === 'inspect' || parts[2] === 'history'
  if (sub === 'container') {
    if (parts[2] === 'ls' || parts[2] === 'inspect' || parts[2] === 'top' || parts[2] === 'port' || parts[2] === 'diff') return true
    if (parts[2] === 'logs') return !parts.some((p) => p === '--follow' || p.startsWith('--follow=') || p.startsWith('-f'))
    return parts[2] === 'stats' && parts.includes('--no-stream')
  }
  return false
}

function isIpRead(parts: string[]): boolean {
  let i = 1
  while (parts[i]?.startsWith('-')) {
    if (!['-4', '-6', '-o', '-s', '-b', '-br', '-oneline', '-brief', '-stats', '-statistics'].includes(parts[i])) return false
    i += 1
  }
  const object = parts[i]
  if (!object || !['addr', 'address', 'link', 'route', 'rule', 'neigh', 'maddress'].includes(object)) return false
  const action = parts[i + 1]
  return action === undefined || action === 'show' || action === 'list' || ((object === 'route' || object === 'neigh') && action === 'get')
}

function isIfconfigRead(parts: string[]): boolean {
  let interfaces = 0
  for (const p of parts.slice(1)) {
    if (p.startsWith('-')) {
      if (!['-a', '-s', '-v', '--all', '--verbose'].includes(p)) return false
    } else {
      interfaces += 1
    }
  }
  return interfaces <= 1
}

function isMountRead(parts: string[]): boolean {
  return parts.slice(1).every((p) => ['-l', '--show-labels', '-v', '--verbose'].includes(p))
}

function isSwaponRead(parts: string[]): boolean {
  return parts.slice(1).every((p) => ['--show', '-s', '--bytes', '--noheadings', '--raw'].includes(p))
}

function isHostnameRead(parts: string[]): boolean {
  return parts.slice(1).every((p) => ['-I', '-i', '-s', '-f', '-d', '-a', '-A', '-y', '--help', '--version'].includes(p))
}

function isHostnamectlRead(parts: string[]): boolean {
  const sub = parts[1]
  return sub === undefined || (parts.length === 2 && ['status', '--help', '--version'].includes(sub))
}

function isTimedatectlRead(parts: string[]): boolean {
  const sub = parts[1]
  return sub === undefined || (parts.length === 2 && ['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync'].includes(sub))
}

function isLocalectlRead(parts: string[]): boolean {
  const sub = parts[1]
  return sub === undefined || (parts.length === 2 && ['status', 'list-locales', 'list-keymaps', 'list-x11-keymap-models'].includes(sub))
}

function isLoginctlRead(parts: string[]): boolean {
  const sub = parts[1]
  return sub === undefined || ['list-sessions', 'list-users', 'user-status', 'session-status', 'show-user', 'show-session'].includes(sub)
}

function isJournalctlRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) =>
    p === '--rotate' || p.startsWith('--vacuum') || p === '--flush' || p === '--sync' ||
    p === '--update-catalog' || p.startsWith('--relinquish-var') ||
    p === '-f' || p.startsWith('--follow')
  )
}

function isDmesgRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) =>
    p === '--clear' || p === '-C' || p === '-c' || p === '--console-level' || p.startsWith('--console-level=') ||
    p === '--follow' || p === '-w'
  )
}

function isSedRead(parts: string[]): boolean {
  const args = parts.slice(1)
  const scriptIndex = args.findIndex((p) => !p.startsWith('-'))
  if (scriptIndex < 0) return false
  const options = args.slice(0, scriptIndex)
  if (!options.every((p) => ['-n', '--quiet', '--silent', '-E', '-r', '--regexp-extended', '-nE', '-En'].includes(p))) return false
  if (args.slice(scriptIndex + 1).some((p) => p.startsWith('-'))) return false
  const quoted = args[scriptIndex]
  const script = quoted.length >= 2 && (
    (quoted.startsWith("'") && quoted.endsWith("'")) ||
    (quoted.startsWith('"') && quoted.endsWith('"'))
  ) ? quoted.slice(1, -1) : quoted
  return script.includes('p') && /^[0-9,$%p;\s-]+$/.test(script)
}

function isFindRead(body: string): boolean {
  return !/\s-(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint(?:0)?|fprintf)\b/.test(body)
}

function isSortRead(parts: string[]): boolean {
  return !parts.some((p) =>
    p.startsWith('-o') || p === '--output' || p.startsWith('--output=') ||
    p === '--compress-program' || p.startsWith('--compress-program=') ||
    p.startsWith('-T') || p === '--temporary-directory' || p.startsWith('--temporary-directory=')
  )
}

function isRgRead(parts: string[]): boolean {
  return !parts.some((p) => p === '--pre' || p.startsWith('--pre=') || p === '--hostname-bin' || p.startsWith('--hostname-bin='))
}

function isTailRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) => p.startsWith('-f') || p.startsWith('-F') || p.startsWith('--follow') || p.startsWith('--retry'))
}

function isDateRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) => p.startsWith('-s') || p.startsWith('--set'))
}

function isPrintfRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) => p.startsWith('-v'))
}

function isSarRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) => p.startsWith('-o'))
}

function isPingRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) =>
    ['-f', '-l', '-s', '-i', '--flood', '--preload', '--size', '--interval'].some((flag) => p.startsWith(flag))
  )
}

function isBlkidRead(parts: string[]): boolean {
  return !parts.slice(1).some((p) => p === '-g' || p.startsWith('--garbage-collect'))
}

export function isSafetyTier(value: unknown): value is SafetyTier {
  return typeof value === 'string' && (SAFETY_TIERS as readonly string[]).includes(value)
}

export function normalizeSafetyTier(value: unknown): SafetyTier {
  return isSafetyTier(value) ? value : DEFAULT_SAFETY_TIER
}

/** True when saved settings name a tier. A missing field keeps the legacy confirm-all path. */
export function safetyTierEngaged(settings: SafetySettings | null | undefined): boolean {
  if (!settings) return false
  if (isSafetyTier(settings.safetyTier)) return true
  if (settings.safetyTierHosts && Object.keys(settings.safetyTierHosts).some((k) => isSafetyTier(settings.safetyTierHosts?.[k]))) {
    return true
  }
  if (settings.safetyTierSessions && Object.keys(settings.safetyTierSessions).some((k) => isSafetyTier(settings.safetyTierSessions?.[k]))) {
    return true
  }
  return false
}

export function effectiveSafetyTier(
  settings: SafetySettings | null | undefined,
  scope?: { hostId?: string | null; sessionId?: string | null }
): SafetyTier {
  const sessionId = scope?.sessionId?.trim()
  const hostId = scope?.hostId?.trim()
  const session = sessionId ? settings?.safetyTierSessions?.[sessionId] : undefined
  if (isSafetyTier(session)) return session
  const host = hostId ? settings?.safetyTierHosts?.[hostId] : undefined
  if (isSafetyTier(host)) return host
  return normalizeSafetyTier(settings?.safetyTier)
}

export function commandKey(command: string): string {
  return String(command ?? '').replace(/\s+/g, ' ').trim()
}

export type InFlightBook = {
  note(command: string): void
  release(command: string): void
  holds(command: string): boolean
  keys(): string[]
}

export function createInFlightBook(): InFlightBook {
  const keys = new Set<string>()
  return {
    note(command: string) {
      const key = commandKey(command)
      if (key && isInteractiveCommand(command)) keys.add(key)
    },
    release(command: string) {
      keys.delete(commandKey(command))
    },
    holds(command: string) {
      return keys.has(commandKey(command))
    },
    keys() {
      return [...keys]
    }
  }
}

const sessionBooks = new Map<string, InFlightBook>()

/** Renderer / session book. A new user turn should release it. */
export function sessionInFlightBook(scope: string | null | undefined): InFlightBook {
  const id = scope?.trim() || 'global'
  let book = sessionBooks.get(id)
  if (!book) {
    book = createInFlightBook()
    sessionBooks.set(id, book)
  }
  return book
}

export function releaseSessionInFlight(scope: string | null | undefined): void {
  sessionBooks.delete(scope?.trim() || 'global')
}

export function isInteractiveCommand(command: string): boolean {
  return INTERACTIVE.test(String(command ?? ''))
}

export function nonInteractiveAlternative(command: string): string | null {
  const s = String(command ?? '')
  if (/\btop\b|\bhtop\b|\bbtop\b/.test(s)) return 'ps aux --sort=-%cpu | head'
  if (/\bncdu\b/.test(s)) return 'du -h --max-depth=1'
  if (/\bless\b|\bmore\b|\bmost\b/.test(s)) return 'tail -n 80'
  if (/\bman\b/.test(s)) return null
  return null
}

function stripSudo(segment: string): string {
  let s = segment.trim()
  if (!/^sudo\b/.test(s)) return s
  const parts = s.split(/\s+/)
  let i = 1
  while (i < parts.length) {
    const p = parts[i] ?? ''
    if (p === '-u' || p === '-g' || p === '--user' || p === '--group') {
      i += 2
      continue
    }
    if (p.startsWith('-')) {
      i += 1
      continue
    }
    break
  }
  if (i >= parts.length) return s
  return parts.slice(i).join(' ')
}

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    const next = command[i + 1]
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      current += ch
      escaped = true
      continue
    }
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === ';' || ch === '|' || (ch === '&' && command[i - 1] !== '>' && next !== '>')) {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }
  segments.push(current)
  return segments.map((s) => s.trim()).filter(Boolean)
}

function redirectIsWrite(segment: string): boolean {
  const re = /(^|[^<])>>?\s*(\S+)/g
  for (const match of segment.matchAll(re)) {
    const target = match[2] ?? ''
    if (!target || target.startsWith('&')) continue
    if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue
    return true
  }
  for (const match of segment.matchAll(/>\s*&\s+(\S+)/g)) {
    const target = match[1] ?? ''
    if (!['/dev/null', '/dev/stdout', '/dev/stderr'].includes(target)) return true
  }
  return /\btee\b/.test(segment)
}

function isReadSegment(segment: string): boolean {
  const body = stripSudo(segment)
  if (!body) return true
  if (redirectIsWrite(body)) return false
  const parts = body.split(/\s+/)
  const bin = parts[0] ?? ''
  const sub = parts[1] ?? ''
  if (bin === 'systemctl') return SYSTEMCTL_READ.has(sub)
  if (bin === 'service') return sub === 'status' || parts[2] === 'status'
  if (bin === 'git') return isGitRead(parts)
  if (bin === 'docker' || bin === 'podman') return isDockerRead(parts)
  if (bin === 'ip') return isIpRead(parts)
  if (bin === 'ifconfig') return isIfconfigRead(parts)
  if (bin === 'mount') return isMountRead(parts)
  if (bin === 'swapon') return isSwaponRead(parts)
  if (bin === 'hostname') return isHostnameRead(parts)
  if (bin === 'hostnamectl') return isHostnamectlRead(parts)
  if (bin === 'timedatectl') return isTimedatectlRead(parts)
  if (bin === 'localectl') return isLocalectlRead(parts)
  if (bin === 'loginctl') return isLoginctlRead(parts)
  if (bin === 'journalctl') return isJournalctlRead(parts)
  if (bin === 'dmesg') return isDmesgRead(parts)
  if (bin === 'tail') return isTailRead(parts)
  if (bin === 'date') return isDateRead(parts)
  if (bin === 'printf') return isPrintfRead(parts)
  if (bin === 'sar') return isSarRead(parts)
  if (bin === 'ping') return isPingRead(parts)
  if (bin === 'blkid') return isBlkidRead(parts)
  if (bin === 'sed') return isSedRead(parts)
  if (bin === 'find') return isFindRead(body)
  if (bin === 'du') return !/\s--delete\b/.test(body)
  if (bin === 'sort') return isSortRead(parts)
  if (bin === 'rg') return isRgRead(parts)
  return READ_BIN.has(bin)
}

function isLocalHigh(command: string): boolean {
  if (assessCommandRisk(command)) return true
  if (/(?:^|[;&|]\s*)(?:sudo(?:\s+\S+)*\s+)?(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/.test(command)) return true
  if (/\bmkfs(?:\.\w+)?\b/.test(command)) return true
  if (/\bdd\b[^|;&]*\bof=\/dev\/(?!null\b|zero\b)/.test(command)) return true
  if (/>\s*\/dev\/(?:sd[a-z]|nvme\d|vd[a-z]|xvd[a-z]|hd[a-z])/.test(command)) return true
  return false
}

/** Local kind. The badge is a separate label; a high badge or a local high rule both count as high. */
export function classifyCommand(command: string, riskLevel?: string | null): CommandKind {
  const text = String(command ?? '').trim()
  if (!text) return 'write'
  if (hasUnverifiableShellSyntax(text)) return 'high'
  if (isInteractiveCommand(text)) return 'interactive'
  if (riskLevel === 'high' || isLocalHigh(text)) return 'high'
  const segments = splitSegments(text)
  if (segments.length === 0) return 'write'
  if (segments.every(isReadSegment)) return 'read'
  return 'write'
}

function hostListed(scope: SafetyScope): boolean {
  const allow = (scope.allowHosts ?? []).map((row) => row.trim()).filter(Boolean)
  if (allow.length === 0) return false
  const ids = [scope.hostId, scope.hostName].map((row) => row?.trim()).filter((row): row is string => Boolean(row))
  return ids.some((id) => allow.includes(id))
}

function autopilotPermitted(scope: SafetyScope): { ok: boolean; warn: boolean } {
  const allow = (scope.allowHosts ?? []).map((row) => row.trim()).filter(Boolean)
  const listed = hostListed(scope)
  if (scope.production && !listed) return { ok: false, warn: true }
  if (allow.length > 0 && !listed) return { ok: false, warn: true }
  return { ok: true, warn: false }
}

function modeFor(applied: SafetyTier, kind: CommandKind, scope: SafetyScope): SafetyMode {
  if (kind === 'interactive') {
    if (scope.book?.holds(scope.command)) return 'hold'
    // H02: suggest-only (observe) never offers Agree/write for interactive either — copy/fill only.
    if (applied === 'observe') return 'suggest'
    return 'agree'
  }
  if (kind === 'high') {
    if (
      applied === 'autopilot' &&
      scope.allowHighRisk === true &&
      scope.production !== true
    ) {
      return 'auto'
    }
    if (applied === 'observe') return 'suggest'
    if (applied === 'confirm') return 'strong'
    return 'agree'
  }
  if (kind === 'read') return 'auto'
  if (applied === 'observe') return 'suggest'
  if (applied === 'confirm') return 'agree'
  return 'auto'
}

export function decideSafetyGate(scope: SafetyScope): SafetyDecision {
  const command = String(scope.command ?? '')
  const kind = classifyCommand(command, scope.riskLevel)
  let applied = scope.tier
  let warn = false
  if (scope.tier === 'autopilot') {
    const permit = autopilotPermitted(scope)
    warn = permit.warn
    if (!permit.ok) applied = 'confirm'
  }
  const mode = command.trim() ? modeFor(applied, kind, { ...scope, command }) : 'agree'
  const alternative = kind === 'interactive' ? nonInteractiveAlternative(command) : null
  return {
    mode,
    kind,
    tier: scope.tier,
    appliedTier: applied,
    warn,
    alternative,
    offerAgree: mode === 'agree' || mode === 'strong',
    strong: mode === 'strong',
    write: mode === 'auto',
    waitForAgree: mode === 'agree' || mode === 'strong'
  }
}

export function planCommandConfirm(scope: SafetyScope): SafetyDecision {
  return decideSafetyGate(scope)
}

export function normalizeTierMap(raw: unknown): Record<string, SafetyTier> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, SafetyTier> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim()
    if (!id || !isSafetyTier(value)) continue
    out[id] = value
  }
  return Object.keys(out).length ? out : undefined
}

export function normalizeAllowHosts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = [...new Set(raw.map((row) => String(row).trim()).filter(Boolean))]
  return out.length ? out : undefined
}
