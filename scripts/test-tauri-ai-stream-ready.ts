/** Tauri AI stream must be subscribed before chat, or fast replies become「无响应」. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const bridge = readFileSync('src/renderer/src/tauri-bridge.ts', 'utf8')
assert.match(bridge, /type StreamUnsub/)
assert.match(bridge, /stop\.ready\s*=/)
assert.match(bridge, /onStream:\s*\(cb: AnyFn\):\s*StreamUnsub/)

const panel = readFileSync('src/renderer/src/components/AIPanel.tsx', 'utf8')
assert.match(panel, /streamReady/)
assert.match(panel, /await streamReady/)
assert.match(panel, /catch \(err\)/)
assert.match(panel, /toolName \|\|[\s\S]{0,80}tool/)

const agent = readFileSync('src-tauri/src/agent.rs', 'utf8')
assert.match(agent, /fn resolve_tool_alias/)
assert.match(agent, /fn normalize_step_structured/)
assert.match(agent, /obj\.insert\("toolName"/)
assert.match(agent, /description 必填/)
assert.match(agent, /不要把工具名放进 action/)

console.log('test-tauri-ai-stream-ready ok')
