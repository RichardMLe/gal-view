// 全局自动存档控制器(apply 级,不依赖任何视图组件挂载):
// - 回合计数:官方 history 转写(captureTranscript)为唯一计数来源,与存档内容同源;
// - 触发源(双源):sessions.list 订阅(主,上游 v0.1.2 实测仍在,byId[id].running 驱动
//   回合落定通知)+ 当前会话 binding.session 订阅(兜底,防运行时 list 面差异);
// - 落定判定:复用 api.waitSettled(binding 快照/list 快照双路径);
// - 保存动作:api.performFileSave(history 转写 + 一致性守卫 + 互斥);
// - 状态发布:statusSource 可观察源(设置面板显示"上次结果/下次还需几轮")。
// 零 React 依赖,纯注入接口,可单测。

/** 从会话列表快照取当前会话 id(与 index.mjs 的 sessionOf 同语义)。 */
function sessionOf(snapshot) {
  if (snapshot === null || snapshot === undefined) return null
  if (typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current
  if (typeof snapshot.currentId === 'string' && snapshot.currentId !== '') return snapshot.currentId
  return null
}

/**
 * @param deps.sessionsSvc - 客户端 sessions 服务(list 订阅 + getSnapshot)。
 * @param deps.api - createSceneApi 产物(waitSettled/performFileSave/captureTranscript)。
 * @param deps.sceneSource - 场景设置(autoSaveEvery)。
 * @param deps.statusSource - 自动存档状态可观察源(update/getSnapshot)。
 * @returns disposer。
 */
export function createGlobalAutoSave({ sessionsSvc, api, sceneSource, statusSource }) {
  const perSession = new Map()
  let currentId = null
  let disposed = false

  const keyOf = id => 'gal-view:auto:' + String(id)

  const every = () => {
    const value = sceneSource !== null && sceneSource !== undefined && typeof sceneSource.getSnapshot === 'function'
      ? sceneSource.getSnapshot()?.settings?.autoSaveEvery
      : undefined
    return typeof value === 'number' ? value : 10
  }

  const publish = (patch) => {
    if (statusSource === null || statusSource === undefined || typeof statusSource.update !== 'function') return
    statusSource.update({ ...statusSource.getSnapshot(), ...patch })
  }

  const readStoredBaseline = (id) => {
    try {
      const n = Number(window.localStorage.getItem(keyOf(id)))
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    } catch {
      return null
    }
  }

  const initSession = async (id) => {
    if (perSession.has(id)) return
    perSession.set(id, { turns: 0, baseline: null })
    if (typeof api?.captureTranscript === 'function') {
      try {
        const transcript = await api.captureTranscript(id)
        if (transcript !== null && transcript !== undefined && transcript.error === null && typeof transcript.turns === 'number') {
          const rec = perSession.get(id)
          if (rec !== null && rec !== undefined) rec.turns = transcript.turns
        } else if (transcript !== null && transcript !== undefined) {
          publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '无法读取会话记录:' + String(transcript.error ?? '未知') })
        }
      } catch {
        // 忽略:history 不可用时转写计数不可用(自动存档降级为不触发)。
      }
    }
    const rec = perSession.get(id)
    if (rec === null || rec === undefined) return
    // 旧版本留下的基线可能大于当前总回合数(旧计数口径),钳制到 ≤ 当前回合,
    // 否则「轮次-基线 < 间隔」永远成立、自动存档永不触发。
    const stored = readStoredBaseline(id)
    rec.baseline = stored !== null ? Math.min(stored, rec.turns) : rec.turns
    publish({ turns: rec.turns, baseline: rec.baseline, every: every() })
    void maybeSave()
  }

  const maybeSave = async () => {
    if (disposed) return
    const id = currentId
    if (id === null || id === undefined) return
    const rec = perSession.get(id)
    if (rec === null || rec === undefined) return
    if (rec.busy) return
    const interval = every()
    if (interval <= 0) {
      publish({ turns: rec.turns, baseline: rec.baseline, every: interval })
      return
    }
    if (typeof api?.captureTranscript !== 'function' || typeof api?.waitSettled !== 'function' || typeof api?.performFileSave !== 'function') return
    // 节流随间隔缩放(间隔 1 → 3s;大间隔封顶 10s):检查会走一次完整 history 转写,
    // 又要满足"每 N 轮一档",固定 10s 会把间隔=1 的连续存档合并。
    const throttleMs = Math.max(3000, Math.min(10000, interval * 3000))
    const nowMs = Date.now()
    if (typeof rec.lastCheckAt === 'number' && nowMs - rec.lastCheckAt < throttleMs) return
    rec.lastCheckAt = nowMs
    rec.busy = true
    try {
      // 以官方 history 转写为唯一计数来源(与存档内容同源、真实总回合数,
      // 不依赖列表 running 跃迁信号)。
      const transcript = await api.captureTranscript(id)
      const turns = transcript !== null && transcript !== undefined && transcript.error === null && typeof transcript.turns === 'number' ? transcript.turns : null
      if (turns === null) {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '无法读取会话记录' + (transcript !== null && transcript !== undefined && transcript.error !== null ? ':' + String(transcript.error) : '') })
        return
      }
      rec.turns = turns
      if (rec.baseline === null) {
        const stored = readStoredBaseline(id)
        rec.baseline = stored !== null ? Math.min(stored, turns) : turns
      } else if (rec.baseline > turns) {
        rec.baseline = turns
      }
      publish({ turns, baseline: rec.baseline, every: interval })
      if (turns - rec.baseline < interval) return
      if (runningOf(id)) return
      const gate = await api.waitSettled({
        quietMs: 1500,
        timeoutMs: 30000,
        shouldContinue: () => runningOf(id) !== true,
      })
      if (!gate.settled) {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '回合未落定' })
        console.info('[gal-view] 自动存档:回合未落定,跳过本轮(下次结算重试)')
        return
      }
      const result = await api.performFileSave({
        auto: true,
        // 自动档不调用官方导出端点:导出在主机侧触发会话日志持久化屏障,
        // 纯后台自动档无法锁定用户输入,新回合若恰在此窗口开始会与活跃回合
        // 交互,曾引发官方窗口重装(对话消失)。自动档记录=完整文本转写 md。
        skipZip: true,
        guardCheck: async () => {
          const t2 = await api.captureTranscript(id)
          return { sessionId: id, turns: t2 !== null && t2 !== undefined && t2.error === null ? t2.turns : null }
        },
      })
      if (result.ok) {
        rec.baseline = turns
        try { window.localStorage.setItem(keyOf(id), String(rec.baseline)) } catch { /* 忽略 */ }
        publish({ lastAt: Date.now(), lastResult: 'ok', lastReason: '', turns, baseline: rec.baseline, every: interval })
        console.info('[gal-view] 自动存档完成(间隔 ' + interval + ' 轮)')
      } else {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: String(result.reason ?? '未知') })
        console.info('[gal-view] 自动存档跳过:', result.reason)
      }
    } catch (cause) {
      publish({ lastAt: Date.now(), lastResult: 'error', lastReason: String(cause?.message ?? cause) })
      console.warn('[gal-view] 自动存档失败:', cause)
    } finally {
      rec.busy = false
    }
  }

  /** 运行态查询(双源):list.byId 优先(running 字段仍在),binding 会话快照兜底。 */
  const runningOf = (id) => {
    try {
      const snap = sessionsSvc?.list?.getSnapshot?.() ?? null
      const entry = sessionOf(snap) === id ? snap?.byId?.[id] : null
      if (entry !== null && entry !== undefined && typeof entry.running === 'boolean') return entry.running
    } catch {
      // 忽略:走 binding 兜底
    }
    try {
      const session = sessionsSvc?.binding?.(id)?.session ?? null
      const s = typeof session?.getSnapshot === 'function' ? session.getSnapshot() : null
      return s?.running === true
    } catch {
      return false
    }
  }

  /** 当前会话 id(双源):list.current 优先(服务级权威),视图注入兜底。 */
  const resolveId = () => {
    try {
      const id = sessionOf(sessionsSvc?.list?.getSnapshot?.() ?? null)
      if (id !== null) return id
    } catch {
      // 忽略:走视图注入
    }
    return typeof api?.currentSessionId === 'function' ? api.currentSessionId() : null
  }

  /** 绑定当前会话快照订阅(兜底触发源);binding 在会话 scope 建立前为 undefined,
   * 故每次 tick 都重试(boundSessionId 守卫,幂等)。 */
  let boundSessionId = null
  let offSession = null
  const ensureSessionBinding = (id) => {
    if (disposed || boundSessionId === id) return
    try {
      const session = sessionsSvc?.binding?.(id)?.session ?? null
      if (session !== null && typeof session.subscribe === 'function') {
        boundSessionId = id
        offSession = session.subscribe(() => { void maybeSave() })
      }
    } catch {
      // 忽略:list 订阅仍会驱动 tick
    }
  }

  const tick = () => {
    if (disposed) return
    const id = resolveId()
    if (id !== currentId) {
      currentId = id
      if (offSession !== null) {
        offSession()
        offSession = null
      }
      boundSessionId = null
      if (id !== null && id !== undefined) {
        void initSession(id)
        ensureSessionBinding(id)
      }
      publish({ turns: 0, baseline: 0 })
      return
    }
    if (id !== null && id !== undefined) ensureSessionBinding(id)
    void maybeSave()
  }

  // 触发源:list 订阅(主)+ 会话快照订阅(兜底);两个源是同一状态机的不同投影,
  // 重复通知由 maybeSave 的节流(lastCheckAt)吸收。
  const offList = typeof sessionsSvc?.list?.subscribe === 'function' ? sessionsSvc.list.subscribe(tick) : null
  tick()
  const offScene = typeof sceneSource?.subscribe === 'function'
    ? sceneSource.subscribe(() => { void maybeSave() })
    : null

  return () => {
    disposed = true
    if (offList !== null) offList()
    if (offSession !== null) offSession()
    if (offScene !== null) offScene()
  }
}
