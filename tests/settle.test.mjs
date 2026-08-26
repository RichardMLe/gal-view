import test from 'node:test'
import assert from 'node:assert/strict'
import { settledOf, hasCompletedTurns, waitSettled } from '../.dsh-plugin/client/settle.mjs'

test('settledOf 只认 running===false', () => {
  assert.equal(settledOf(null), false)
  assert.equal(settledOf(undefined), false)
  assert.equal(settledOf({}), false)
  assert.equal(settledOf({ running: true }), false)
  assert.equal(settledOf({ running: false }), true)
})

test('hasCompletedTurns:completed=true 且非 blank', () => {
  assert.equal(hasCompletedTurns(null), false)
  assert.equal(hasCompletedTurns({}), false)
  assert.equal(hasCompletedTurns({ completed: false }), false)
  assert.equal(hasCompletedTurns({ completed: true }), true)
  assert.equal(hasCompletedTurns({ completed: true, blank: true }), false)
})

const snapshot = (current, entry) => ({
  current,
  byId: current === null ? {} : { [current]: entry },
})

const instant = () => new Promise(resolve => { resolve() })

test('waitSettled:已落定且静默 → settled', async () => {
  const gate = await waitSettled({
    getSnapshot: () => snapshot('s1', { running: false, completed: true }),
    subscribe: null,
    quietMs: 0,
    timeoutMs: 1000,
    sleep: instant,
  })
  assert.deepEqual(gate, { settled: true, completed: true, aborted: false })
})

test('waitSettled:running=true 直到超时 → 不落定', async () => {
  const gate = await waitSettled({
    getSnapshot: () => snapshot('s1', { running: true }),
    subscribe: null,
    quietMs: 0,
    timeoutMs: 20,
    sleep: instant,
  })
  assert.equal(gate.settled, false)
  assert.equal(gate.completed, false)
  assert.equal(gate.aborted, false)
})

test('waitSettled:shouldContinue=false → aborted', async () => {
  const gate = await waitSettled({
    getSnapshot: () => snapshot('s1', { running: false, completed: true }),
    subscribe: null,
    quietMs: 0,
    timeoutMs: 1000,
    sleep: instant,
    shouldContinue: () => false,
  })
  assert.equal(gate.aborted, true)
  assert.equal(gate.settled, false)
})

test('waitSettled:无当前会话 → 永不落定(超时返回)', async () => {
  const gate = await waitSettled({
    getSnapshot: () => snapshot(null, null),
    subscribe: null,
    quietMs: 0,
    timeoutMs: 20,
    sleep: instant,
  })
  assert.equal(gate.settled, false)
})

test('waitSettled:列表变化重置静默计时(持续变化则推迟落定到超时)', async () => {
  // subscribe 每 60ms 触发一次变化(每次轮询周期内都重置静默计时),
  // quietMs=100 永远凑不满 → 超时返回不落定;并验证 subscribe 确实被调用。
  let fired = 0
  const gate = await waitSettled({
    getSnapshot: () => snapshot('s1', { running: false, completed: true }),
    subscribe: cb => {
      const timer = setInterval(() => { fired += 1; cb() }, 60)
      return () => clearInterval(timer)
    },
    quietMs: 100,
    timeoutMs: 160,
    sleep: () => new Promise(resolve => setTimeout(resolve, 50)),
  })
  assert.equal(gate.settled, false)
  assert.ok(fired >= 2)
  // 对照:无变化时同样参数应能落定(静默 100ms 在超时前凑满)。
  const gate2 = await waitSettled({
    getSnapshot: () => snapshot('s1', { running: false, completed: true }),
    subscribe: null,
    quietMs: 100,
    timeoutMs: 160,
    sleep: () => new Promise(resolve => setTimeout(resolve, 50)),
  })
  assert.equal(gate2.settled, true)
})
