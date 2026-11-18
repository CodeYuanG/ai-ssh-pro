/** Concurrent multi-session AI: per-key busy + runId abort + no preemptive abort. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

const panel = norm('src/renderer/src/components/AIPanel.tsx')
assert.ok(panel.includes('busyKeys'), 'busy tracked per conversation key')
assert.ok(panel.includes('turnsByKeyRef'), 'multiple in-flight turns')
assert.ok(panel.includes('setSessionBusy'), 'session busy helper')
assert.match(panel, /abortChat\(cur\?\.id\)/, 'Stop aborts only this run')
assert.ok(panel.includes('evRun && evRun !== turn.id'), 'ignore other runs on stream')

const agent = norm('src-tauri/src/agent.rs')
assert.ok(agent.includes('abort_run'), 'tauri agent per-run abort')
assert.ok(agent.includes('emit_ai_stream') || agent.includes('crate::ai::emit_ai_stream'), 'tagged stream emits')
assert.ok(agent.includes('runs: Mutex'), 'run registry')

const ai = norm('src-tauri/src/ai.rs')
assert.ok(ai.includes('pub fn emit_ai_stream'))
assert.ok(ai.includes('history_key'))
assert.ok(ai.includes('abort_run'))

const lib = norm('src-tauri/src/lib.rs')
assert.match(lib, /fn ai_abort_chat\([^)]*run_id: Option<String>/)

const electron = norm('src/main/ai-interactive-agent.ts')
assert.ok(electron.includes('activeAiChats'), 'electron multi-run map')
assert.ok(electron.includes('emitRunStore'), 'ALS runId tagging')
assert.equal(electron.includes('if (activeAiChat) {\n    abortAiChat()\n  }'), false, 'no preemptive abort')
assert.match(electron, /export function abortAiChat\(runId\?: string\)/)

const bridge = norm('src/renderer/src/tauri-bridge.ts')
assert.match(bridge, /abortChat: async \(runId\?: string\)/)

const ipc = norm('src/shared/ipc.ts')
assert.ok(ipc.includes('runId?: string'))

console.log('test-ai-multi-session: ok')
