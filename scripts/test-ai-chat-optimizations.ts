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
assert.ok(panel.includes('role="log"'), 'transcript keeps log semantics for history browsing')
assert.match(panel, /role="log"\s+aria-label=\{tg\('ai\.transcript'\)\}\s+aria-live="off"/, 'streaming tokens do not trigger transcript announcements')
assert.ok(!panel.includes('aria-relevant="additions text"'), 'transcript no longer requests text-change announcements')
assert.match(panel, /data-testid="ai-live-status"\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"/, 'terminal states share one atomic polite status region')
assert.ok(panel.includes("setLiveStatus('')"), 'a new turn clears the previous terminal announcement')
assert.ok(!panel.includes("setLiveStatus(tg('ai.busy'))"), 'generation start is not announced as a live status')
for (const key of ['ai.cancelled', 'ai.replyFailed', 'ai.replyReady']) {
  assert.ok(panel.includes(`setLiveStatus(terminalState.current === 'cancelled' ? tg('ai.cancelled') : terminalState.current === 'error' ? tg('ai.replyFailed') : tg('ai.replyReady')`) || panel.includes(`tg('${key}')`), `${key} is wired into status announcements`)
}
assert.ok(panel.includes('htmlFor={composerInputId}') && panel.includes('id={composerInputId}'), 'composer label is explicitly associated with its textarea')
assert.ok(panel.includes('rows={1}'), 'composer starts with one row before content-driven sizing')

const styles = norm('src/renderer/src/styles.css')
const textareaRules = [...styles.matchAll(/\.ai-panel \.ai-input-row \.ai-composer textarea\s*\{([^}]*)\}/g)]
const textareaRule = textareaRules.at(-1)?.[1] ?? ''
assert.match(textareaRule, /height:\s*auto/, 'textarea height follows its content')
assert.match(textareaRule, /field-sizing:\s*content/, 'textarea uses native content sizing')
assert.match(textareaRule, /min-height:\s*64px/, 'empty composer keeps its compact minimum height')
assert.match(textareaRule, /max-height:\s*160px/, 'composer growth is capped')
assert.match(textareaRule, /overflow-y:\s*auto/, 'overflowing text remains scrollable')
const commandRule = styles.match(/\.ai-dark-card \.ai-reply-cmd-code\s*\{([^}]*)\}/)?.[1] ?? ''
assert.match(commandRule, /white-space:\s*pre-wrap/, 'commands preserve line breaks while wrapping')
assert.match(commandRule, /word-break:\s*normal/, 'commands are not split inside arguments')
assert.match(commandRule, /overflow-wrap:\s*normal/, 'long command tokens retain horizontal scrolling')
assert.doesNotMatch(commandRule, /break-all/, 'dark command cards do not split every character')
assert.ok(panel.includes('function CommandText') && panel.includes('command.split(/(\\s+)/)'), 'command rendering preserves whitespace between intact tokens')
assert.ok(panel.includes('className="ai-reply-cmd-token"'), 'command cards render token spans')
const tokenRule = styles.match(/\.ai-reply-cmd-token\s*\{([^}]*)\}/)?.[1] ?? ''
assert.match(tokenRule, /white-space:\s*nowrap/, 'hyphenated command arguments do not split across lines')

const i18n = norm('src/renderer/src/lib/i18n.tsx')
for (const key of ['ai.inputLabel', 'ai.transcript', 'ai.replyReady', 'ai.replyFailed']) {
  assert.equal(i18n.split(`'${key}':`).length - 1, 2, `${key} has Chinese and English copy`)
}

// --- App/index wiring ----------------------------------------------------------------------
const index = norm('src/main/index.ts')
assert.ok(index.includes('abortAllAiChats'), 'abort-all is wired explicitly')

console.log('test-ai-chat-optimizations ok')
