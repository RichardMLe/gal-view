// 全局自动存档控制器(apply 级,不依赖任何视图组件挂载):
// - 回合计数:官方 history 转写(captureTranscript)为唯一计数来源,与存档内容同源;
// - 触发源(三保险):
//   ① sessions.list 订阅(主,上游 v0.1.2 实测仍在,byId[id].running 驱动回合落定通知)
//   ② 当前会话 binding.session 订阅(兜底,防运行时 list 面差异)
//   ③ 心跳轮询(默认 2s):list 订阅若在 apply 时错过服务挂载(offList=null)也能自愈;
//      同时负责基线初始化重试(initSession 失败后不断重试直到拿到转写)
// - 节流竞态自愈:回合刚结束时到达的 tick 常落在节流窗口内(会话流式期间 tick 频繁,
//   最后一次检查贴近回合结束),若直接丢弃该 tick,安静下来的会话不会再有任何事件,
//   该回合的自动档就永久错过(8-29 实测:自动15 触发后自动16 永不出现)。因此节流
//   拦截时不丢弃,而是安排一次延迟结算(节流到期后再跑 maybeSave)。
// - 转写瞬时失败(窗口未就绪)有限重试(3s/6s 各一次),永久失败则等下次事件;
// - 落定判定:复用 api.waitSettled(binding 快照/list 快照双路径);
// - 保存动作:api.performFileSave(history 转写 + 一致性守卫 + 互斥);
// - 状态发布:statusSource 可观察源(设置面板显示"上次结果/下次还需几轮")。
// 零 React 依赖,纯注入接口,可单测(heartbeatMs/throttleMsOf 可注入加速测试)。

import { LS_KEYS } from './persist.mjs'

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
 * @param deps.heartbeatMs - 心跳周期(默认 2000;测试注入小值)。
 * @param deps.throttleMsOf - 节流策略 (interval) => ms(默认 3s 起步、随间隔缩放、10s 封顶)。
 * @returns disposer。
 */
export function createGlobalAutoSave({ sessionsSvc, api, sceneSource, statusSource, heartbeatMs = 2000, throttleMsOf = null }) {
  const perSession = new Map()
  let currentId = null
  let disposed = false
  let retryTimer = null
  let retryAttempt = 0

  const keyOf = id => LS_KEYS.autoPrefix + ':' + String(id)

  const every = () => {
    const value = sceneSource !== null && sceneSource !== undefined && typeof sceneSource.getSnapshot === 'function'
      ? sceneSource.getSnapshot()?.settings?.autoSaveEvery
      : undefined
    return typeof value === 'number' ? value : 10
  }

  const throttleFor = (interval) => {
    if (typeof throttleMsOf === 'function') return Math.max(0, throttleMsOf(interval))
    return Math.max(3000, Math.min(10000, interval * 3000))
  }

  const publish = (patch) => {
    if (statusSource === null || statusSource === undefined || typeof statusSource.update !== 'function') return
    statusSource.update({ ...statusSource.getSnapshot(), ...patch })
  }

  /** 决策日志:每个结算决策落一行到存档目录 dotfile(诊断回放用,见 appendAutosaveLog)。 */
  const log = (line) => {
    if (typeof api?.appendAutosaveLog === 'function') void api.appendAutosaveLog(line)
  }

  const readStoredBaseline = (id) => {
    try {
      const n = Number(window.localStorage.getItem(keyOf(id)))
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    } catch {
      return null
    }
  }

  /** 延迟结算(单定时器,幂等):节流拦截/转写瞬时失败/结算忙时安排,不丢回合。 */
  const scheduleRetry = (delayMs) => {
    if (disposed || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void maybeSave()
    }, Math.max(0, delayMs))
  }

  /** 基线初始化(可重试):首次成功转写建立 turns/baseline;失败保持 initOk=false,
   * 由心跳 pulse 持续重试——list 订阅若在 apply 时错过服务,基线也能自愈建立。 */
  const initSession = async (id) => {
    let rec = perSession.get(id)
    if (rec === null || rec === undefined) {
      rec = { turns: 0, baseline: null, initOk: false, initBusy: false }
      perSession.set(id, rec)
    }
    if (rec.initOk === true || rec.initBusy === true) return
    rec.initBusy = true
    try {
      if (typeof api?.captureTranscript === 'function') {
        let ok = false
        try {
          const transcript = await api.captureTranscript(id)
          if (transcript !== null && transcript !== undefined && transcript.error === null && typeof transcript.turns === 'number') {
            rec.turns = transcript.turns
            ok = true
          } else if (transcript !== null && transcript !== undefined) {
            publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '无法读取会话记录:' + String(transcript.error ?? '未知') })
          }
        } catch {
          // 忽略:history 不可用时转写计数不可用(心跳会重试初始化)。
        }
        if (!ok) return
      }
      rec.initOk = true
      // 旧版本留下的基线可能大于当前总回合数(旧计数口径),钳制到 ≤ 当前回合,
      // 否则「轮次-基线 < 间隔」永远成立、自动存档永不触发。
      const stored = readStoredBaseline(id)
      rec.baseline = stored !== null ? Math.min(stored, rec.turns) : rec.turns
      publish({ turns: rec.turns, baseline: rec.baseline, every: every() })
      void maybeSave()
    } finally {
      rec.initBusy = false
    }
  }

  const maybeSave = async () => {
    if (disposed) return
    const id = currentId
    if (id === null || id === undefined) return
    const rec = perSession.get(id)
    if (rec === null || rec === undefined) return
    if (rec.busy) {
      scheduleRetry(1500)
      return
    }
    const interval = every()
    if (interval <= 0) {
      publish({ turns: rec.turns, baseline: rec.baseline, every: interval })
      return
    }
    if (typeof api?.captureTranscript !== 'function' || typeof api?.waitSettled !== 'function' || typeof api?.performFileSave !== 'function') return
    // 节流随间隔缩放(间隔 1 → 3s;大间隔封顶 10s):检查会走一次完整 history 转写,
    // 又要满足"每 N 轮一档",固定 10s 会把间隔=1 的连续存档合并。
    const throttleMs = throttleFor(interval)
    const nowMs = Date.now()
    if (typeof rec.lastCheckAt === 'number' && nowMs - rec.lastCheckAt < throttleMs) {
      // 节流拦截 ≠ 丢弃:回合结束时刻的 tick 常落在这里,而此后会话安静、不再有事件;
      // 安排延迟结算保证该回合的自动档最终被结算(见文件头注释的 8-29 事故)。
      const delay = rec.lastCheckAt + throttleMs - nowMs + 80
      scheduleRetry(delay)
      log('节流拦截→延迟结算+' + Math.round(delay) + 'ms(turns=' + rec.turns + ',baseline=' + rec.baseline + ')')
      return
    }
    rec.lastCheckAt = nowMs
    rec.busy = true
    try {
      // 以官方 history 转写为唯一计数来源(与存档内容同源、真实总回合数,
      // 不依赖列表 running 跃迁信号)。
      const transcript = await api.captureTranscript(id)
      const turns = transcript !== null && transcript !== undefined && transcript.error === null && typeof transcript.turns === 'number' ? transcript.turns : null
      if (turns === null) {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '无法读取会话记录' + (transcript !== null && transcript !== undefined && transcript.error !== null ? ':' + String(transcript.error) : '') })
        log('转写失败:' + String(transcript !== null && transcript !== undefined ? transcript.error : '空') + '(retry=' + retryAttempt + ')')
        // 转写瞬时失败(事件窗口尚未就绪)有限重试;永久失败则等下次事件/心跳。
        if (retryAttempt < 2) {
          retryAttempt += 1
          scheduleRetry(3000 * retryAttempt)
        }
        return
      }
      retryAttempt = 0
      rec.turns = turns
      if (rec.baseline === null) {
        const stored = readStoredBaseline(id)
        rec.baseline = stored !== null ? Math.min(stored, turns) : turns
      } else if (rec.baseline > turns) {
        rec.baseline = turns
      }
      publish({ turns, baseline: rec.baseline, every: interval })
      if (turns - rec.baseline < interval) {
        log('轮次未达(间隔' + interval + '):' + turns + '-' + rec.baseline)
        return
      }
      if (runningOf(id)) {
        log('运行中跳过(turns=' + turns + ')')
        return
      }
      const gate = await api.waitSettled({
        quietMs: 1500,
        timeoutMs: 30000,
        shouldContinue: () => runningOf(id) !== true,
      })
      if (!gate.settled) {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: '回合未落定' })
        console.info('[gal-view] 自动存档:回合未落定,跳过本轮(有限重试补档)')
        log('回合未落定(retry=' + retryAttempt + ',turns=' + turns + ')')
        // 落定失败 = 会话还在动(新回合立刻开始/流式未停)。有限重试:安静下来后
        // 本回合的档还能补上;不重试则只能等下一次事件,快速连续回合时会丢档
        // (8-30 实测:四次测试仅一次落盘)。永久性落定失败由 runningOf 闸门兜底。
        if (retryAttempt < 2) {
          retryAttempt += 1
          scheduleRetry(4000 * retryAttempt)
        }
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
        retryAttempt = 0
        rec.baseline = turns
        try { window.localStorage.setItem(keyOf(id), String(rec.baseline)) } catch { /* 忽略 */ }
        publish({ lastAt: Date.now(), lastResult: 'ok', lastReason: '', turns, baseline: rec.baseline, every: interval })
        log('已存档(turns=' + turns + ',baseline→' + rec.baseline + ')')
        console.info('[gal-view] 自动存档完成(间隔 ' + interval + ' 轮)')
      } else if (result.reason === 'busy') {
        // 存档互斥锁被占(手动档进行中):重试而非丢弃——否则本回合不更新基线,
        // 锁释放后被再次结算成同回合重复档(8-30 实测:test1 回合连写自动2/自动3)。
        log('互斥锁占用,排1.5s重试(turns=' + turns + ')')
        scheduleRetry(1500)
      } else {
        publish({ lastAt: Date.now(), lastResult: 'skipped', lastReason: String(result.reason ?? '未知') })
        log('跳过:' + String(result.reason ?? '未知') + '(turns=' + turns + ')')
        console.info('[gal-view] 自动存档跳过:', result.reason)
      }
    } catch (cause) {
      publish({ lastAt: Date.now(), lastResult: 'error', lastReason: String(cause?.message ?? cause) })
      log('异常:' + String(cause?.message ?? cause))
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
   * 故每次 tick/pulse 都重试(boundSessionId 守卫,幂等)。 */
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

  /** 会话切换(事件 tick 与心跳 pulse 共用)。 */
  const switchTo = (id) => {
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
  }

  /** 事件触发:会话变化即结算。 */
  const tick = () => {
    if (disposed) return
    const id = resolveId()
    if (id !== currentId) {
      switchTo(id)
      return
    }
    if (id !== null && id !== undefined) ensureSessionBinding(id)
    void maybeSave()
  }

  /** 心跳(默认 2s):不直接结算(避免静默期每 2s 一次全量转写),只做三件自愈:
   * ① 会话切换检测(订阅在 apply 时错过服务也能跟上);
   * ② binding 订阅补挂;
   * ③ 基线初始化重试(initSession 转写失败时)。 */
  const pulse = () => {
    if (disposed) return
    const id = resolveId()
    if (id !== currentId) {
      switchTo(id)
      return
    }
    if (id !== null && id !== undefined) {
      ensureSessionBinding(id)
      const rec = perSession.get(id)
      if (rec !== null && rec !== undefined && rec.initOk !== true) void initSession(id)
    }
  }

  // 触发源:list 订阅(主)+ 会话快照订阅(兜底)+ 心跳(自愈);
  // 前两者是同一状态机的不同投影,重复通知由 maybeSave 的节流吸收。
  const offList = typeof sessionsSvc?.list?.subscribe === 'function' ? sessionsSvc.list.subscribe(tick) : null
  tick()
  const heartbeatTimer = setInterval(pulse, Math.max(200, heartbeatMs))
  const offScene = typeof sceneSource?.subscribe === 'function'
    ? sceneSource.subscribe(() => { void maybeSave() })
    : null

  return () => {
    disposed = true
    clearInterval(heartbeatTimer)
    if (retryTimer !== null) clearTimeout(retryTimer)
    if (offList !== null) offList()
    if (offSession !== null) offSession()
    if (offScene !== null) offScene()
  }
}
