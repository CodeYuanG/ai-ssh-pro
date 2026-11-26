/** P0/P1 AI chat optimisation guards: static prompt prefix, snapshot window, abort semantics, batching. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { partialDescriptionText } from '../src/main/ai-interactive-agent.ts'
import { extractJsonObjectText, sliceJsonObject } from '../src/shared/ai-json.ts'

const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

// --- JSON slicing survives trailing prose and a second object -------------------------------
assert.equal(sliceJsonObject('noise {"a":1} more'), '{"a":1}')
assert.equal(
  sliceJsonObject('{"description":"a \\"quoted\\" {brace}","action":"end"} tail {"x":2}'),
  '{"description":"a \\"quoted\\" {brace}","action":"end"}'
)
assert.equal(extractJsonObjectText('```json\n{"action":"end"}\n```'), '{"action":"end"}')
assert.equal(extractJsonObjectText('prefix {"a":{"b":1}} suffix'), '{"a":{"b":1}}')

// --- Partial description streaming decodes escapes safely -----------------------------------
assert.equal(partialDescriptionText('{"description":"磁盘满'), '磁盘满')
assert.equal(partialDescriptionText('{"description":"line1\\nline2'), 'line1\nline2')
assert.equal(partialDescriptionText('{"description":"unterminated \\u00'), 'unterminated ')
assert.equal(partialDescriptionText('{"action":"end"}'), '')

// --- Main process: static prompt prefix, no per-step sleep, snapshot window honoured --------
const agent = norm('src/main/ai-interactive-agent.ts')
assert.ok(agent.includes('buildStaticSystemPrompt'), 'static prompt prefix exists')
assert.ok(agent.includes('staticSystemPromptCache'), 'static prompt is cached')
assert.ok(
  agent.indexOf("content: staticPrompt }") < agent.indexOf("content: sysPrompt }"),
  'static prefix is sent before per-step state'
)
assert.ok(!agent.includes('content: sysPrompt + \'\\n\\n\' + actionsPrompt()'), 'actions prompt no longer rebuilt per step')
assert.ok(agent.includes('jsonRepairUsed'), 'one JSON repair round per run')
assert.ok(agent.includes('lastToolResult == null'), 'step sleep only when nothing was observed')
assert.ok(!/await new Promise<void>\(\(resolve\) => setTimeout\(resolve, pollWaitMs\)\)\n\s*}\n\n\s*send\(wc, \{\n\s*type: 'step',/.test(agent))
assert.ok(agent.includes('opts?: { maxLines?: number; includeCommandLine?: boolean }'), 'snapshot window is a parameter')
assert.ok(agent.includes('includeCommandLine\n          })') || agent.includes('includeCommandLine: includeCommandLine'), 'snapshot window passed through')
assert.match(agent, /export function abortAiChat\(runId\?: string\): boolean/)
assert.ok(agent.includes('if (!id) return false'), 'blank runId does not abort every run')
assert.ok(agent.includes('export function abortAllAiChats'))
assert.ok(!agent.includes('JSON.parse(JSON.stringify(m))'), 'debug message snapshots are not deep-cloned')

// --- Renderer: batching, scroll pin, banner, no silent clipboard overwrite ------------------
const panel = norm('src/renderer/src/components/AIPanel.tsx')
assert.ok(panel.includes('scheduleDelta'), 'delta chunks are batched')
assert.ok(panel.includes('requestAnimationFrame'), 'batching is frame-aligned')
assert.ok(!panel.includes('if (usedStepProtocol) return'), 'later steps still stream (no first-step-only gate)')
assert.ok(panel.includes('stepDeltasExpected'), 'delta window follows status/step events')
assert.ok(panel.includes('stickToBottomRef'), 'scroll follows only when pinned')
assert.ok(!panel.includes("onMouseUp={() => {\n              const ta = inputRef.current"), 'select-copy removed')
assert.ok(panel.includes('sendingRef'), 'send() has a synchronous latch')
assert.ok(panel.includes('safetySnapshotRef'), 'safety context read from latest ref')
assert.match(panel, /\{turnElsewhere \? \(/, 'elsewhere banner not gated on own busy')
assert.ok(panel.includes('role="log"'), 'transcript is a live log region')

// --- App/index wiring ----------------------------------------------------------------------
const index = norm('src/main/index.ts')
assert.ok(index.includes('abortAllAiChats'), 'abort-all is wired explicitly')

console.log('test-ai-chat-optimizations ok')
