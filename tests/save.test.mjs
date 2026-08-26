import test from 'node:test'
import assert from 'node:assert/strict'
import {
  saveRootPrefix, saveTitleMatcher, summaryOf, rootOf, descendantsOf,
  collectSaves, nextSaveTitle, autoTitleMatcher, nextAutoTitle, collectSlots,
  isValidSlotTitle,
} from '../.dsh-plugin/client/save.mjs'

test('saveRootPrefix 取前 3 字并压缩空白,空回退 GAL', () => {
  assert.equal(saveRootPrefix('深海捕鲸计划'), '深海捕')
  assert.equal(saveRootPrefix('  a  b c  '), 'a b')
  assert.equal(saveRootPrefix('  '), 'GAL')
  assert.equal(saveRootPrefix(undefined), 'GAL')
})

test('saveTitleMatcher 匹配 xx-saveN 且前缀转义', () => {
  const m = saveTitleMatcher('深海捕')
  assert.match('深海捕-save1', m)
  assert.match('深海捕-save12', m)
  assert.doesNotMatch('深海捕-saveX', m)
  assert.doesNotMatch('深海捕-save', m)
  assert.doesNotMatch('深海捕-save1-副本', m)
  const dot = saveTitleMatcher('a.b')
  assert.ok(dot.test('a.b-save1'))
  assert.ok(!dot.test('aXb-save1'))
})

test('summaryOf 统一字段读取(宿主字段名兜底)', () => {
  const a = summaryOf({ sessionId: 's1', title: 'T', parentSessionId: 's0', updatedAt: 5 }, 'x')
  assert.deepEqual(a, { id: 's1', title: 'T', parentId: 's0', updatedAt: 5 })
  const b = summaryOf({ id: 's2', parentId: 's1', createdAt: 7 }, 's2')
  assert.deepEqual(b, { id: 's2', title: '', parentId: 's1', updatedAt: 7 })
  const c = summaryOf(null, 's3')
  assert.equal(c.id, 's3')
  assert.equal(c.parentId, null)
})

test('rootOf 沿父链上溯,父缺失即停', () => {
  const byId = {
    s0: { sessionId: 's0', title: '主线程' },
    s1: { sessionId: 's1', title: 'xx-save1', parentSessionId: 's0' },
    s2: { sessionId: 's2', title: 'xx-save2', parentSessionId: 's1' },
  }
  assert.equal(rootOf(byId, 's2'), 's0')
  assert.equal(rootOf(byId, 's0'), 's0')
  assert.equal(rootOf(byId, 'orphan'), 'orphan')
  // 父不在表内:停在当前
  const c = { s5: { sessionId: 's5', title: 'x', parentSessionId: 'ghost' } }
  assert.equal(rootOf(c, 's5'), 's5')
})

test('descendantsOf 递归含隔代', () => {
  const byId = {
    s0: { sessionId: 's0' },
    s1: { sessionId: 's1', parentSessionId: 's0' },
    s2: { sessionId: 's2', parentSessionId: 's1' },
    s3: { sessionId: 's3', parentSessionId: 's0' },
  }
  assert.deepEqual(descendantsOf(byId, 's0').sort(), ['s1', 's2', 's3'])
  assert.deepEqual(descendantsOf(byId, 's1'), ['s2'])
  assert.deepEqual(descendantsOf(byId, 's9'), [])
})

test('collectSaves 只收命名匹配的分支且按 n 升序', () => {
  const byId = {
    s0: { sessionId: 's0', title: '深海说' },
    s1: { sessionId: 's1', title: '深海-save2', parentSessionId: 's0', updatedAt: 20 },
    s2: { sessionId: 's2', title: '深海-save1', parentSessionId: 's0', updatedAt: 10 },
    s3: { sessionId: 's3', title: '深海-saveX', parentSessionId: 's0' },
    s4: { sessionId: 's4', title: '普通分支', parentSessionId: 's1', updatedAt: 30 },
  }
  const saves = collectSaves(byId, 's0', '深海')
  assert.deepEqual(saves.map(s => [s.title, s.n, s.updatedAt]), [
    ['深海-save1', 1, 10],
    ['深海-save2', 2, 20],
  ])
})

test('nextSaveTitle 取最大号 + 1', () => {
  assert.equal(nextSaveTitle('深海', []), '深海-save1')
  assert.equal(nextSaveTitle('深海', [2, 5]), '深海-save6')
  assert.equal(nextSaveTitle('深海', ['x', null]), '深海-save1')
})

test('自动存档：autoTitleMatcher/nextAutoTitle/collectSlots（特殊标识+永不覆盖+剔除当前）', () => {
  assert.match('深海-自动1', autoTitleMatcher('深海'))
  assert.doesNotMatch('深海-save1', autoTitleMatcher('深海'))
  assert.doesNotMatch('深海-自动X', autoTitleMatcher('深海'))
  assert.equal(nextAutoTitle('深海', []), '深海-自动1')
  assert.equal(nextAutoTitle('深海', [1, 3]), '深海-自动4')
  const byId = {
    s0: { sessionId: 's0', title: '深海说', parentSessionId: undefined },
    s1: { sessionId: 's1', title: '深海-save1', parentSessionId: 's0', updatedAt: 10 },
    s2: { sessionId: 's2', title: '深海-自动1', parentSessionId: 's0', updatedAt: 20 },
    s3: { sessionId: 's3', title: '深海-自动2', parentSessionId: 's1', updatedAt: 30 },
    cur: { sessionId: 'cur', title: '深海-save1', parentSessionId: 's1', updatedAt: 40 },
  }
  const { saves, autos } = collectSlots(byId, 's0', '深海', 'cur')
  assert.deepEqual(saves.map(s => s.title), ['深海-save1'])
  assert.deepEqual(autos.map(s => s.title), ['深海-自动1', '深海-自动2'])
})

test('isValidSlotTitle：中文/英文/数字/部分符号可，特殊字符拒绝', () => {
  assert.equal(isValidSlotTitle('请阅读-save1'), true)
  assert.equal(isValidSlotTitle('第一章 开局…！？'), true)
  assert.equal(isValidSlotTitle('abc_123 - x.y'), true)
  assert.equal(isValidSlotTitle('  '), false)
  assert.equal(isValidSlotTitle('a/b\\c'), false)
  assert.equal(isValidSlotTitle('有<标签>'), false)
  assert.equal(isValidSlotTitle('含#号'), false)
  assert.equal(isValidSlotTitle('x'.repeat(41)), false)
})
