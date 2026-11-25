import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyCommand, planCommandConfirm } from '../src/shared/safety-tier'
import type { CommandKind, SafetyMode, SafetyTier } from '../src/shared/safety-tier'

type Case = {
  id: string
  command: string
  kind: CommandKind
  riskLevel?: string
}

type Fixture = { version: number; cases: Case[] }

const root = join(import.meta.dirname, '..')
const fixture = JSON.parse(readFileSync(join(root, 'tests/fixtures/ai-command-safety.json'), 'utf8')) as Fixture
assert.equal(fixture.version, 1)
assert.ok(fixture.cases.length >= 90)

const expectedMode: Record<SafetyTier, Record<CommandKind, SafetyMode>> = {
  confirm: { read: 'auto', write: 'agree', high: 'strong', interactive: 'agree' },
  autopilot: { read: 'auto', write: 'auto', high: 'agree', interactive: 'agree' },
  observe: { read: 'auto', write: 'suggest', high: 'suggest', interactive: 'suggest' }
}

for (const row of fixture.cases) {
  const riskLevel = row.riskLevel ?? 'medium'
  assert.equal(classifyCommand(row.command, riskLevel), row.kind, `${row.id}: kind`)
  for (const tier of Object.keys(expectedMode) as SafetyTier[]) {
    const decision = planCommandConfirm({
      tier,
      command: row.command,
      riskLevel,
      allowHosts: [],
      production: false,
      allowHighRisk: false
    })
    assert.equal(decision.kind, row.kind, `${row.id}: ${tier} kind`)
    assert.equal(decision.mode, expectedMode[tier][row.kind], `${row.id}: ${tier} mode`)
    assert.equal(decision.write, decision.mode === 'auto', `${row.id}: ${tier} write`)
    assert.equal(decision.waitForAgree, decision.mode === 'agree' || decision.mode === 'strong', `${row.id}: ${tier} wait`)
  }
}

console.log(`test-ai-command-safety: ok (${fixture.cases.length} commands across 3 policies)`)
