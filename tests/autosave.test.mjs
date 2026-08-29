// 自动存档控制器行为测试(触发自愈/节流竞态——8-29 事故回归):
// - 回合结束 tick 落在节流窗口内 → 延迟结算仍保存(事故:自动15 后自动16 永不出现);
// - list 订阅错过服务挂载 → 心跳自愈并重试基线初始化直到转写可用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createGlobalAutoSave } from '../.dsh-plugin/client/autosave.mjs'

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
  },
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const observable = (initial) => {
  let state = initial
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update(patch) {
      state = { ...state, ...patch }
      for (const fn of [...listeners]) fn()
    },
  }
}

/** 组装可控世界:转写回合数/错误、running 态、list 与 binding 双订阅、存档记录。 */
function makeWorld({ autoSaveEvery = 1, withList = true } = {}) {
  let turns = 5
  let transcriptError = null
  let running = false
  const saves = []
  const status = observable({ lastAt: null, lastResult: null, lastReason: '', turns: 0, baseline: 0, every: autoSaveEvery })
  const scene = observable({ settings: { autoSaveEvery } })
  const listListeners = new Set()
  const bindingListeners = new Set()
  const list = {
    getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', running, blank: false } } }),
    subscribe: fn => {
      listListeners.add(fn)
      return () => { listListeners.delete(fn) }
    },
  }
  const sessionsSvc = {
    list: withList ? list : undefined,
    binding: () => ({
      session: {
        subscribe: fn => {
          bindingListeners.add(fn)
          return () => { bindingListeners.delete(fn) }
        },
        getSnapshot: () => ({ running }),
      },
      eventSource: { getSnapshot: () => ({ entries: [] }) },
    }),
  }
  const api = {
    currentSessionId: () => 's1',
    captureTranscript: async () => ({ lines: [], turns, atSeq: 1, error: transcriptError }),
    waitSettled: async (opts) => {
      const ok = typeof opts?.shouldContinue === 'function' ? opts.shouldContinue() : true
      return { settled: ok, completed: true, aborted: false }
    },
    performFileSave: async (opts) => {
      saves.push(opts)
      return { ok: true }
    },
  }
  return {
    setTurns: t => { turns = t },
    setRunning: r => { running = r },
    setError: e => { transcriptError = e },
    saves, status, scene, sessionsSvc, api,
    fireList: () => { for (const fn of [...listListeners]) fn() },
    fireBinding: () => { for (const fn of [...bindingListeners]) fn() },
  }
}

test('节流竞态自愈:回合结束 tick 落在节流窗口内,延迟结算仍完成保存(8-29 事故回归)', async () => {
  const world = makeWorld()
  const dispose = createGlobalAutoSave({
    sessionsSvc: world.sessionsSvc, api: world.api,
    sceneSource: world.scene, statusSource: world.status,
    heartbeatMs: 200, throttleMsOf: () => 120,
  })
  try {
    // 初始 tick:建立基线(转写 turns=5 → baseline=5),期间 lastCheckAt 被占用
    await sleep(160)
    assert.equal(world.status.getSnapshot().turns, 5)
    // 回合开始(running=true;turn/start 已入日志 → 转写 6):运行中不保存
    world.setTurns(6)
    world.setRunning(true)
    world.fireList()
    await sleep(40)
    assert.equal(world.saves.length, 0)
    // 回合结束:20ms 内到达的 tick 落在 120ms 节流窗口内 → 被拦截并安排延迟结算;
    // 此后没有任何事件(会话安静)——旧实现这里直接丢 tick,自动档永久错过。
    world.setRunning(false)
    world.fireList()
    await sleep(50)
    assert.equal(world.saves.length, 0, '节流窗口内不应立即保存')
    // 延迟结算在节流到期后自行触发 → 保存成功
    await sleep(400)
    assert.equal(world.saves.length, 1)
    assert.equal(world.saves[0].auto, true)
    assert.equal(world.status.getSnapshot().lastResult, 'ok')
  } finally {
    dispose()
  }
})

test('心跳自愈:list 不可用(订阅错过服务挂载)→ 基线初始化重试直到转写可用', async () => {
  const world = makeWorld({ withList: false })
  world.setError('无法取得会话尾 seq(会话窗口未打开)')
  const dispose = createGlobalAutoSave({
    sessionsSvc: world.sessionsSvc, api: world.api,
    sceneSource: world.scene, statusSource: world.status,
    heartbeatMs: 200, throttleMsOf: () => 120,
  })
  try {
    // 初始 tick + 第一轮心跳:转写不可用 → 基线未建立
    await sleep(300)
    assert.equal(world.status.getSnapshot().turns, 0)
    // 窗口就绪后,心跳继续重试初始化 → 基线建立
    world.setError(null)
    await sleep(500)
    assert.equal(world.status.getSnapshot().turns, 5)
    assert.equal(world.status.getSnapshot().baseline, 5)
  } finally {
    dispose()
  }
})
