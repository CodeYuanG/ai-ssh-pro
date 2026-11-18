/** Cursor-like AI chat transcript wiring. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const panel = readFileSync('src/renderer/src/components/AIPanel.tsx', 'utf8')
assert.ok(panel.includes('groupChatTurns'))
assert.ok(panel.includes("data-chat-ui=\"cursor\""))
assert.ok(panel.includes('ChatMarkdown'))
assert.ok(panel.includes('ai-turn--'))
assert.ok(panel.includes('ai.roleYou') && panel.includes('ai.roleAssistant'))
assert.ok(panel.includes('e.isComposing'))

const md = readFileSync('src/renderer/src/components/ChatMarkdown.tsx', 'utf8')
assert.ok(md.includes('react-markdown') && md.includes('remarkGfm'))

const css = readFileSync('src/renderer/src/styles.css', 'utf8')
assert.ok(css.includes("data-chat-ui='cursor'") || css.includes('data-chat-ui="cursor"') || css.includes("[data-chat-ui='cursor']"))
assert.ok(css.includes('.ai-chat-md'))
assert.ok(css.includes('.ai-turn--user'))

const i18n = readFileSync('src/renderer/src/lib/i18n.tsx', 'utf8')
assert.equal(i18n.split("'ai.roleYou':").length - 1, 2)
assert.equal(i18n.split("'ai.roleAssistant':").length - 1, 2)

console.log('test-ai-chat-cursor-ui: ok')
