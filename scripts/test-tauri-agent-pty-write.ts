/** Tauri AI command must write into the live SSH PTY (not side-channel exec). */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const agent = readFileSync('src-tauri/src/agent.rs', 'utf8')
assert.match(agent, /ssh\.write\(&sid,\s*format!\("\{command\}\\n"\)\)/)
assert.match(agent, /durationMs/)
assert.match(agent, /summarize_pty_output/)
assert.match(agent, /"status":\s*"sent"/)
assert.match(agent, /"noExit":\s*"unsupported"/)
assert.doesNotMatch(agent, /ssh\.exec\(&sid,\s*command\.clone\(\)/)
console.log('test-tauri-agent-pty-write ok')
