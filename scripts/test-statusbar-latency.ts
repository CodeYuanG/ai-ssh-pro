/** Status-bar SSH RTT chip via workspace.ping. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatStatusLatency } from '../src/shared/status-bar'
import { classifyLatency, LATENCY_POLL_MS } from '../src/shared/workspace-features'

assert.equal(formatStatusLatency(undefined, 'zh-CN'), null)
assert.equal(formatStatusLatency(42, 'zh-CN'), '延迟 42 ms')
assert.equal(formatStatusLatency(42, 'en'), 'RTT 42 ms')
assert.equal(formatStatusLatency(null, 'en'), 'RTT —')
assert.equal(classifyLatency(40), 'good')
assert.ok(LATENCY_POLL_MS >= 1000)

const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
assert.match(app, /statusbar-latency/)
assert.match(app, /workspace\.ping/)
assert.match(app, /formatStatusLatency/)
assert.match(app, /statusLatencyMs/)

const i18n = readFileSync('src/renderer/src/lib/i18n.tsx', 'utf8')
assert.ok(i18n.includes("'sb.latencyTip'"))

const bridge = readFileSync('src/renderer/src/tauri-bridge.ts', 'utf8')
assert.match(bridge, /workspace_ping/)
assert.doesNotMatch(bridge, /ping:\s*async\s*\(\)\s*=>\s*null/)

const rust = readFileSync('src-tauri/src/lib.rs', 'utf8')
assert.match(rust, /async fn workspace_ping/)
assert.match(rust, /workspace_ping,/)

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string; scripts: { test: string; 'test:parts'?: string } }
assert.equal(pkg.version, '0.8.0')
assert.match(pkg.scripts['test:parts'] || pkg.scripts.test, /test-statusbar-latency/)
console.log('test-statusbar-latency ok')
