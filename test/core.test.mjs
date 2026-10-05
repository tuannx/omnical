import { test } from 'node:test'
import assert from 'node:assert'
import { fallbackParse, detectStall } from '../src/nutrition.ts'

test('fallbackParse totals a text meal', () => {
  const out = fallbackParse('2 eggs, toast and a latte')
  assert.ok(out.items.length >= 3, JSON.stringify(out.items))
  assert.equal(out.kcal, 78 * 2 + 90 + 150)
  assert.ok(out.protein > 10)
})

test('fallbackParse prefers chicken breast over chicken', () => {
  const out = fallbackParse('grilled chicken breast with rice')
  assert.equal(out.items.filter(i => i.name.includes('chicken')).length, 1)
  assert.ok(out.items.some(i => i.name.includes('rice')))
})

test('detectStall flags flat weight with good adherence', () => {
  const day = 86400000, t0 = Date.now() - 10 * day
  const weights = [0, 3, 7, 10].map(d => ({ weight_kg: 72.5, created_at: t0 + d * day }))
  const out = detectStall(weights, 0.9)
  assert.equal(out.stalled, true)
  assert.match(out.suggestion, /-100 kcal|−100 kcal|adjust/i)
})

test('detectStall ignores short windows', () => {
  const out = detectStall([{ weight_kg: 72, created_at: Date.now() }], 1)
  assert.equal(out.stalled, false)
})
