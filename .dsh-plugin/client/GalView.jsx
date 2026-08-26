/** GAL 视窗顶层：模式切换 + 游戏模式（舞台/控制条/输入/历史/设置）+ 编辑模式。
 * 数据来源：useSession（会话快照 nodes/partial/running/blank）、useScene（场景）、
 * inputActions（发送走宿主输入机，与普通输入框同一管线）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StageView } from './StageView.jsx'
import { Editor } from './Editor.jsx'
import { PendingPanel } from './PendingPanel.jsx'
import { createTypeState, setTarget, skip, advance, SPEEDS } from './typewriter.mjs'
import {
  nodesToLines, partialToText, deriveActivity, speakerFor, welcomeLine, assistantDisplayName,
} from './transcript.mjs'
import { splitPages, createFitsMeasurer } from './paging.mjs'
import { saveRootPrefix, nextSaveTitle } from './save.mjs'
import { normalizePersona } from './persona.mjs'

/** 玩家消息完整显示后的最短滞留时长（此后由模型状态触发翻页）。 */
const STATUS_DWELL_MS = 1500
/** 模型状态迟迟未到时的兜底等待上限（超过后按当前状态翻页）。 */
const STATUS_MAX_WAIT_MS = 6000

/** 发送玩家输入：走宿主输入机（adjudication/claim/默认 sink 同一管线）。
 * 草稿与会话输入机共享：GAL 与「对话」栏同一草稿，切换标签页不丢。 */
function useSend(inputActions, draft, clearDraft) {
  return useCallback(() => {
    const text = draft.trim()
    if (text === '') return
    inputActions.setDraft(text)
    inputActions.submit()
    clearDraft()
  }, [draft, inputActions, clearDraft])
}

/** 对话历史面板（右侧滑出）。 */
function HistoryPanel({ scene, lines, onClose }) {
  const listRef = useRef(null)
  useEffect(() => {
    const list = listRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }, [lines])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  return (
    <div className="gv-history" role="dialog" aria-label="对话历史">
      <div className="gv-history-head">
        <span>历史</span>
        <button type="button" className="gv-btn" onClick={onClose}>关闭</button>
      </div>
      <div className="gv-history-list" ref={listRef}>
        {lines.length === 0 && <div className="gv-history-empty">还没有对话记录</div>}
        {lines.map(line => {
          const speaker = speakerFor(scene, line.kind)
          return (
            <div className="gv-history-row" key={line.key}>
              <span className="gv-history-name" style={{ color: speaker.color }}>{speaker.name}</span>
              <p className="gv-history-text">{line.text}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 设置浮层：说话角色 / 玩家名 / 打字速度。开时快照、关时提交历史。 */
function SettingsPanel({ scene, api, onClose }) {
  const beforeRef = useRef(null)
  useEffect(() => {
    beforeRef.current = api.snapshotScene()
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (beforeRef.current !== null) {
        api.commitHistory(beforeRef.current)
        beforeRef.current = null
      }
    }
  }, [api, onClose])
  const characters = scene.elements.filter(el => el.type === 'character' && el.character)
  return (
    <div className="gv-settings" role="dialog" aria-label="设置">
      <div className="gv-settings-head">
        <span>设置</span>
        <button type="button" className="gv-btn" onClick={onClose}>关闭</button>
      </div>
      <label className="gv-settings-row">
        <span>说话角色</span>
        <select
          value={scene.settings.assistantSpeaker}
          onChange={e => api.updateSettings({ assistantSpeaker: e.target.value })}
        >
          {characters.map(el => (
            <option key={el.id} value={el.id}>{el.character.name}（{el.character.label}）</option>
          ))}
          <option value="">系统</option>
        </select>
      </label>
      <label className="gv-settings-row">
        <span>玩家名</span>
        <input
          type="text"
          value={scene.settings.playerName}
          onChange={e => api.updateSettings({ playerName: e.target.value })}
          placeholder="你"
        />
      </label>
      <label className="gv-settings-row">
        <span>打字速度</span>
        <select value={scene.settings.typeSpeed} onChange={e => api.updateSettings({ typeSpeed: e.target.value })}>
          <option value="slow">慢</option>
          <option value="normal">正常</option>
          <option value="fast">快</option>
        </select>
      </label>
      <label className="gv-settings-row">
        <span>自动存档间隔</span>
        <input
          type="number"
          min={0}
          max={100}
          value={scene.settings.autoSaveEvery ?? 10}
          onChange={e => {
            const n = parseInt(e.target.value, 10)
            if (Number.isFinite(n)) api.updateSettings({ autoSaveEvery: Math.min(100, Math.max(0, n)) })
          }}
        />
      </label>
      <p className="gv-settings-hint">每完成 N 次对话自动创建「自动」快照（0 = 关闭）；自动快照仅保留最新一个。存档/读档会在回复完全落定后执行，不打断对话。</p>
    </div>
  )
}

/** 存档/读档面板：快照式（经典 galgame 语义）。
 * SAVE = 当前会话最后已完成回合冻结为快照槽（xx-saveN / xx-自动N），永不改变；
 * LOAD = 从槽派生新世界线 → 切换 → 销毁旧世界线（归档，列表消失）。
 * 宿主不支持会话服务时给出可读提示，不抛错。 */
function SavePanel({ api, mode, onClose, running }) {
  const [index, setIndex] = useState(() => loadSaveIndex(api))
  const [current, setCurrent] = useState(() => loadCurrentSession(api))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const refresh = useCallback(() => {
    setIndex(loadSaveIndex(api))
    setCurrent(loadCurrentSession(api))
  }, [api])
  useEffect(() => {
    refresh()
    if (typeof api?.onSessions !== 'function') return
    return api.onSessions(refresh)
  }, [api, refresh])
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const save = async () => {
    if (busy) return
    if (typeof api?.saveSlot !== 'function' || api.hasSessionsService() !== true) {
      setError('当前环境不支持会话分叉（sessions 服务不可用）')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      // 落定闸门：等主机摘要 running=false 且连续静默后才 fork——对未落定的
      // 活跃会话 fork 会打断官方会话窗口（对话整段消失）。超时给出可读提示。
      if (typeof api?.waitSettled === 'function') {
        setNotice('正在等待回合落定…')
        const gate = await api.waitSettled({ quietMs: 2500, timeoutMs: 15000 })
        if (!gate.settled) throw new Error('回复尚未完全落定，请稍后再存档')
        if (!gate.completed) throw new Error('还没有已完成的回合，先聊几句再存档吧')
      }
      setNotice(null)
      const result = await api.saveSlot()
      setNotice('已创建快照「' + result.title + '」（永久保存，读档也不会改变它）')
      refresh()
    } catch (cause) {
      setError(causeText(cause))
      setNotice(null)
    }
    setBusy(false)
  }
  const load = async (id) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.loadSave(id)
      onClose()
    } catch (cause) {
      setError(causeText(cause))
      setBusy(false)
    }
  }
  // 手动存档改名：点击名称进入编辑，Enter/失焦提交，Escape 取消。
  const beginRename = (slot) => {
    setEditingId(slot.id)
    setEditText(slot.title)
    setError(null)
  }
  const commitRename = async (slot) => {
    const text = editText.trim()
    if (text === '' || text === slot.title) {
      setEditingId(null)
      return
    }
    try {
      if (typeof api?.renameSlot !== 'function') throw new Error('当前环境不支持改名')
      await api.renameSlot(slot.id, text)
      setEditingId(null)
      refresh()
    } catch (cause) {
      setError(causeText(cause))
    }
  }
  const nextTitle = nextSaveTitle(saveRootPrefix(index.rootTitle), index.saves.map(s => s.n))
  const renderSlotRows = (slots, isAuto) => slots.map(s => {
    const editing = !isAuto && editingId === s.id
    return (
      <div className="gv-saves-row" key={s.id}>
        {editing
          ? <input
              className="gv-saves-edit"
              autoFocus
              value={editText}
              onChange={e => setEditText(e.target.value)}
              onBlur={() => commitRename(s)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
                if (e.key === 'Escape') { setEditingId(null) }
              }}
            />
          : <span
              className={'gv-saves-name' + (isAuto ? '' : ' is-renamable')}
              title={isAuto ? undefined : '点击改名'}
              onClick={isAuto ? undefined : () => beginRename(s)}
            >{s.title}</span>}
        <span className="gv-saves-time">{formatTime(s.updatedAt)}</span>
        {isAuto && <span className="gv-saves-badge">自动</span>}
        {mode === 'load' && (
          <button type="button" className="gv-btn" disabled={busy || running === true} onClick={() => load(s.id)}>读取</button>
        )}
      </div>
    )
  })
  return (
    <div className="gv-saves-layer" role="dialog" aria-label={mode === 'save' ? '存档' : '读档'}>
      <div className="gv-saves">
        <div className="gv-saves-head">
          <span>{mode === 'save' ? '存档' : '读档'}</span>
          <button type="button" className="gv-btn" onClick={onClose}>关闭</button>
        </div>
        {mode === 'save'
          ? <p className="gv-saves-hint">存档 = 冻结当前进度的快照「{saveRootPrefix(index.rootTitle)}-save…」，之后读档永远不会改变它。</p>
          : <p className="gv-saves-hint">读取存档 = 从快照重开一条世界线，旧世界线销毁。之后的对话发生在新线上。{running === true ? '当前回复尚未完成，请等它结束后再读取。' : ''}</p>}
        {index.rootTitle !== '' && (
          <p className="gv-saves-meta">主线程「{index.rootTitle}」</p>
        )}
        <div className="gv-saves-list">
          {/* 自动存档槽位常驻（放在手动存档上面）；仅保留最新一个。 */}
          <div className="gv-saves-group">自动存档</div>
          {index.autos.length > 0
            ? renderSlotRows(index.autos, true)
            : <div className="gv-saves-empty gv-saves-auto-empty">当前无自动存档</div>}
          <div className="gv-saves-group">手动存档</div>
          {index.saves.length === 0 && <div className="gv-saves-empty">还没有手动存档</div>}
          {renderSlotRows(index.saves, false)}
        </div>
        {mode === 'save' && (
          <button type="button" className="gv-btn gv-btn-gold gv-saves-create" disabled={busy} onClick={save}>
            创建存档（{nextTitle}）
          </button>
        )}
        {error !== null && <p className="gv-saves-error">{error}</p>}
        {notice !== null && <p className="gv-saves-notice">{notice}</p>}
      </div>
    </div>
  )
}

/** 读取存档索引（api 缺失/异常时返回空结构）。 */
function loadSaveIndex(api) {
  try {
    if (typeof api?.saveIndex !== 'function') return { rootId: null, rootTitle: '', saves: [], autos: [] }
    return api.saveIndex()
  } catch {
    return { rootId: null, rootTitle: '', saves: [], autos: [] }
  }
}

/** 当前会话 id（api 缺失/异常时返回 null）。 */
function loadCurrentSession(api) {
  try {
    if (typeof api?.currentSessionId !== 'function') return null
    return api.currentSessionId()
  } catch {
    return null
  }
}

/** 时间戳 → YYYY-MM-DD HH:mm（无效值返回空串）。 */
function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 响应失败的可读信息。 */
function causeText(cause) {
  if (cause === null || cause === undefined) return '操作失败'
  if (typeof cause === 'object' && typeof cause.message === 'string') return cause.message
  return String(cause)
}

/**
 * 填满会话区：挂载时隐藏会话外壳的输入席（data-composer-seat），让视窗占满整个
 * 会话主体（data-conversation-scroll）。GAL 视窗只在自身激活时被挂载，卸载（切回
 * 「对话」/「轨迹」标签）时恢复原状。找不到外壳（独立挂载/冒烟环境）时静默跳过。
 * @param rootRef - 视窗根节点。
 * @returns 恢复函数。
 */
function useFillSessionArea(rootRef) {
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const scrollBody = root.closest('[data-conversation-scroll]')
    const seat = scrollBody?.querySelector(':scope > [data-composer-seat]') ?? null
    if (scrollBody === null || seat === null) return
    const prev = {
      seatDisplay: seat.style.display,
      overflow: scrollBody.style.overflow,
      position: scrollBody.style.position,
    }
    seat.style.display = 'none'
    scrollBody.style.overflow = 'hidden'
    scrollBody.style.position = 'relative'
    root.setAttribute('data-gal-fills', '')
    return () => {
      seat.style.display = prev.seatDisplay
      scrollBody.style.overflow = prev.overflow
      scrollBody.style.position = prev.position
      root.removeAttribute('data-gal-fills')
    }
  }, [rootRef])
}

/**
 * GAL 视窗组件（conversation.view 槽位条目）。
 * @param props - 槽位框架注入：sessionId/useSession/useInput/inputActions + inject 面的 useScene/useHistory/api。
 */
export function GalView({ useSession, useInput, inputActions, useScene, useHistory, useAssets, useFonts, useStore, useProjection, actions, api }) {
  const scene = useScene(s => s)
  const history = useHistory(h => h)
  const assets = useAssets(a => a)
  const fonts = useFonts(f => f)
  const readState = useStore(s => s)
  const nodes = useSession(s => s.nodes)
  const partial = useSession(s => s.partial)
  const running = useSession(s => s.running)
  const blank = useSession(s => s.blank)
  const runningCalls = useSession(s => s.runningCalls)
  const pending = useSession(s => s.pending)
  const promptError = useSession(s => s.promptError)

  const [mode, setMode] = useState('game')
  const [auto, setAuto] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 存档/读档面板（模式：'save' | 'load' | null 关闭）。
  const [saveMode, setSaveMode] = useState(null)
  // 提问进行时由 PendingPanel 注入：非 null 时输入框按钮切换为「提交答案」。
  const [questionControl, setQuestionControl] = useState(null)
  // 草稿与会话输入机共享（InputState.draft）：切标签页/刷新不丢，且与「对话」栏互通。
  // 无 useInput/inputActions 的独立挂载环境（冒烟测试）回退到本地状态。
  const inputDraft = typeof useInput === 'function' ? useInput(s => s.draft) : undefined
  const [localDraft, setLocalDraft] = useState('')
  const draft = typeof inputDraft === 'string' ? inputDraft : localDraft
  const setSharedDraft = useCallback((text) => {
    if (inputActions !== null && inputActions !== undefined && typeof inputActions.setDraft === 'function') inputActions.setDraft(text)
    else setLocalDraft(text)
  }, [inputActions])
  const [type, setType] = useState(createTypeState)
  const [pages, setPages] = useState([])
  const [pageIndex, setPageIndex] = useState(0)
  const rootRef = useRef(null)
  // 阅读状态恢复/保存（标签页切换与刷新后不从头渲染）。
  const readStateRef = useRef(readState)
  readStateRef.current = readState
  const restoredKeyRef = useRef(null)
  useFillSessionArea(rootRef)

  const lines = useMemo(() => nodesToLines(nodes), [nodes])
  const liveText = running ? partialToText(partial) : ''
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : null
  // ---- 自动存档（主线程快照）----
  // 回合数取 sessionStats 投影的 durable turns（每完成一轮对话 +1，与渲染批次/回复快慢无关；
  // 投影缺失时回退窗口内玩家行数）。每完成 autoSaveEvery 次回合（默认 10，0=关）且
  // 回合结束后创建 xx-自动N 快照。基线按会话持久化（localStorage），标签页切换不重置。
  const autoSaveEvery = typeof scene.settings.autoSaveEvery === 'number' ? scene.settings.autoSaveEvery : 10
  const sessionStats = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined
  const playerTurns = useMemo(() => lines.filter(l => l.kind === 'player').length, [lines])
  const turns = typeof sessionStats?.turns === 'number' ? sessionStats.turns : playerTurns
  const autoSessionId = typeof api?.currentSessionId === 'function'
    ? (api.currentSessionId() ?? 'default')
    : (typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default')
  const autoKey = 'gal-view:auto:' + autoSessionId
  const autoSaveRef = useRef({ key: autoKey, baseline: null, saving: false, trying: false })
  if (autoSaveRef.current.key !== autoKey) {
    autoSaveRef.current = { key: autoKey, baseline: null, saving: false, trying: false }
  }
  if (autoSaveRef.current.baseline === null) {
    let stored = null
    try {
      const n = Number(window.localStorage.getItem(autoKey))
      if (Number.isFinite(n) && n > 0) stored = Math.floor(n)
    } catch { /* 隐私模式 */ }
    // 无记录（新会话）→ 基线=当前回合数；有记录 → 沿用（切标签页/刷新不重置）。
    autoSaveRef.current.baseline = stored ?? turns
  }
  // 落定闸门驱动：订阅会话列表变化作为重试节拍——自动存档条件满足但未落定时，
  // 下一次列表变化（通常是回合真正结算）会再次触发检查。
  const runningRef = useRef(false)
  runningRef.current = running
  const [settleTick, setSettleTick] = useState(0)
  useEffect(() => {
    if (typeof api?.onSessions !== 'function') return undefined
    return api.onSessions(() => setSettleTick(t => t + 1))
  }, [api])
  useEffect(() => {
    const ref = autoSaveRef.current
    if (autoSaveEvery <= 0 || ref.saving || ref.trying) return
    if (turns - ref.baseline < autoSaveEvery) return
    if (running || (Array.isArray(pending) && pending.length > 0)) return
    if (typeof api?.autoSave !== 'function' || typeof api?.waitSettled !== 'function' || api.hasSessionsService() !== true) return
    const currentTurns = turns
    const currentEvery = autoSaveEvery
    ref.trying = true
    // 落定闸门：等主机摘要 running=false 且连续 2.5s 无会话列表变化后才 fork。
    // 不再盲等固定时长——对未落定的活跃会话 fork 会打断官方会话窗口
    // （对话整段消失、只剩工具调用卡片）。未落定就放弃本轮，下次结算重试。
    api.waitSettled({
      quietMs: 2500,
      timeoutMs: 30000,
      shouldContinue: () => runningRef.current === false && autoSaveRef.current.key === autoKey,
    }).then(gate => {
      const r = autoSaveRef.current
      r.trying = false
      if (r.saving || r.key !== autoKey) return
      if (!gate.settled) {
        console.info('[gal-view] 自动存档:回合未落定,跳过本轮(下次结算重试)')
        return
      }
      if (!gate.completed) {
        console.info('[gal-view] 自动存档:尚无已完成回合,跳过')
        return
      }
      r.baseline = currentTurns
      try { window.localStorage.setItem(autoKey, String(r.baseline)) } catch { /* 忽略 */ }
      r.saving = true
      api.autoSave().then(
        () => {
          r.saving = false
          console.info('[gal-view] 自动存档完成(间隔 ' + currentEvery + ' 轮)')
        },
        (cause) => {
          r.saving = false
          r.baseline = Math.max(0, r.baseline - currentEvery)
          console.warn('[gal-view] 自动存档失败:', cause)
        },
      )
    })
  }, [turns, autoSaveEvery, running, pending, api, autoKey, settleTick])
  // 对话行骤降看门狗：同一会话内 nodes 数量骤降(>50%)且非运行中，说明官方
  // 会话窗口被重装成了不完整尾部——调 resync 重拉基线恢复整段对话。
  const nodesCount = Array.isArray(nodes) ? nodes.length : 0
  const nodesWatchRef = useRef({ count: null, session: null, last: 0 })
  useEffect(() => {
    const w = nodesWatchRef.current
    if (w.count === null || w.session !== autoSessionId) {
      w.count = nodesCount
      w.session = autoSessionId
      return
    }
    const prev = w.count
    w.count = nodesCount
    if (!running && prev > 6 && nodesCount < prev / 2) {
      const now = Date.now()
      if (now - w.last > 15000 && typeof api?.reopenCurrent === 'function') {
        w.last = now
        console.warn('[gal-view:watchdog] 检测到对话行骤减 ' + prev + ' → ' + nodesCount + ',重装会话窗口')
        void api.reopenCurrent()
      }
    }
  }, [nodesCount, running, autoSessionId, api])
  // 人设/选项框样式：场景设置驱动（读取时再归一化：编辑中的非法中间态兜底）。
  const personaCfg = useMemo(() => normalizePersona(scene.settings.persona), [scene.settings.persona])
  const pendingStyle = scene.settings.pendingStyle ?? null
  const rootStyle = pendingStyle !== null && typeof pendingStyle === 'object'
    ? {
      '--gv-pending-title-size': String(pendingStyle.titleSize ?? 16) + 'px',
      '--gv-pending-option-size': String(pendingStyle.optionSize ?? 15) + 'px',
      '--gv-pending-detail-size': String(pendingStyle.detailSize ?? 15) + 'px',
    }
    : undefined
  // 结构化活动行：思考摘要/工具调用/生成预览/等待决定/错误（状态页与状态行共用）。
  const activity = useMemo(
    () => deriveActivity({ running, partial, pending, runningCalls, lastLine, promptError, personaCfg }),
    [running, partial, pending, runningCalls, lastLine, promptError, personaCfg],
  )
  // 前台节流：后台流式每块都到达 → 活动行取 350ms 尾随去抖展示，
  // 文字刷新速度与后端解耦（模型执行速度不变）。
  const [shownActivity, setShownActivity] = useState(activity)
  const lastActivityRef = useRef(activity)
  useEffect(() => {
    if (activity === lastActivityRef.current) return
    const timer = setTimeout(() => {
      lastActivityRef.current = activity
      setShownActivity(activity)
    }, 350)
    return () => { clearTimeout(timer) }
  }, [activity])
  // 上下文占用：官方 contextPressure 投影（projectedTokens/pressureTokens + contextWindow）；
  // 槽位未注入 useProjection 或投影未就绪时隐藏指示条。
  const contextPressure = typeof useProjection === 'function' ? useProjection('contextPressure') : undefined
  const contextOccupancy = useMemo(() => {
    const used = contextPressure !== null && typeof contextPressure === 'object' ? (contextPressure.projectedTokens ?? contextPressure.pressureTokens) : undefined
    const windowSize = contextPressure !== null && typeof contextPressure === 'object' ? contextPressure.contextWindow : undefined
    if (typeof used !== 'number' || typeof windowSize !== 'number' || windowSize <= 0) return null
    return { percent: Math.min(100, Math.max(0, Math.round(used / windowSize * 100))), used, windowSize }
  }, [contextPressure])
  const fallback = blank ? welcomeLine(scene) : null
  // 理想规则（用户约定）：文本框显示用户内容 → 名牌「你」；显示 AI 内容 → 名牌 DeepSeek。
  // 运行期间（AI 正文未到）先显示最后一条玩家消息；滞留片刻后「换页」到状态页。
  const pendingPlayer = running
    && lastLine !== null
    && lastLine.kind === 'player'
    && liveText === ''
    ? lastLine
    : null

  // 流式打字进度快照：定稿转分页时据此无缝衔接第一页（不闪空、不重打）。
  // 只快照「有正文」的流式状态（状态页/玩家滞留不覆盖）；新回合开始时丢弃旧快照；
  // 衔接命中后保留（不消费）——定稿后节点列表会短暂振荡回退，保留快照才能钉住回退窗口。
  const streamedTypeRef = useRef(null)
  const wasRunningRef = useRef(false)
  useEffect(() => {
    const was = wasRunningRef.current
    wasRunningRef.current = running
    if (!running) return
    if (!was) streamedTypeRef.current = null
    if (liveText !== '') streamedTypeRef.current = type
  }, [running, type, liveText])

  // 翻页由模型状态触发：玩家消息完整显示后记录滞留起点；
  // 最短滞留（STATUS_DWELL_MS）届满且模型已有状态（思考/工具/正文块）→ 立即翻页；
  // 状态一直未到 → STATUS_MAX_WAIT_MS 后兜底翻页（显示「编写代码中」）。
  const [statusHold, setStatusHold] = useState(false)
  const [dwellSince, setDwellSince] = useState(null)
  useEffect(() => {
    if (!running || pendingPlayer === null) {
      setStatusHold(false)
      setDwellSince(null)
      return
    }
    if (type.done && dwellSince === null) setDwellSince(Date.now())
  }, [running, pendingPlayer, type.done, dwellSince])
  const modelStateArrived = running && (liveText !== ''
    || (partial !== null && typeof partial === 'object' && Array.isArray(partial.blocks) && partial.blocks.length > 0)
    || (Array.isArray(runningCalls) && runningCalls.length > 0)
    || (Array.isArray(pending) && pending.length > 0))
  useEffect(() => {
    if (!running || !type.done || pendingPlayer === null) {
      setStatusHold(false)
      return
    }
    const base = dwellSince ?? Date.now()
    const delay = modelStateArrived
      ? Math.max(0, STATUS_DWELL_MS - (Date.now() - base))
      : STATUS_MAX_WAIT_MS
    const timer = setTimeout(() => { setStatusHold(true) }, delay)
    return () => { clearTimeout(timer) }
  }, [running, type.done, pendingPlayer, modelStateArrived, dwellSince])

  // 流式 → 定稿的完成窗口：定稿节点与 running=false 状态帧是分开到达的，
  // 期间（节点已到/未到）不得闪状态页或重打——用流式快照钉住已输出的正文。
  const capturedTarget = streamedTypeRef.current !== null && typeof streamedTypeRef.current.target === 'string'
    ? streamedTypeRef.current.target
    : ''
  const capturedLine = capturedTarget !== ''
    ? { key: 'live', kind: 'assistant', text: capturedTarget }
    : null
  // 无进行中的工具/待回应才钉住（多步回合的工具阶段仍正常显示状态页）。
  const capturedQuiet = (Array.isArray(runningCalls) && runningCalls.length === 0)
    && (Array.isArray(pending) && pending.length === 0)
  // 定稿节点已落地且与已显示的流式正文衔接：直接展示定稿行（等状态帧转分页）。
  // 锚定可见前缀（capturedShown），与 measure 的衔接分支一致；定稿文本与流式全文可能有分段差异。
  const capturedShown = streamedTypeRef.current !== null && typeof streamedTypeRef.current.shown === 'string'
    ? streamedTypeRef.current.shown
    : ''
  const capturedLanded = capturedQuiet
    && capturedLine !== null
    && lastLine !== null
    && lastLine.kind === 'assistant'
    && lastLine.text.startsWith(capturedShown !== '' ? capturedShown : capturedTarget)
  // 状态帧先到、定稿节点未落地：继续显示流式正文直到节点到达。
  const capturedPending = capturedQuiet
    && capturedLine !== null
    && !capturedLanded
    && (lastLine === null || lastLine.kind === 'player')
  // 状态页：换页后的独立一页——空文本 + 状态行作为正文，名牌为 AI。
  // 流式生成阶段（liveText 非空）也强制走状态页：正文不实时渲染，
  // 定稿（running=false）后才进入回复渲染（打字机/分页）。
  const showStatusPage = running && (liveText !== '' || statusHold || pendingPlayer === null)
  const currentLine = showStatusPage
    ? { key: 'live', kind: 'assistant', text: '' }
    : running
      ? (pendingPlayer ?? (liveText !== ''
        ? { key: 'live', kind: 'assistant', text: liveText }
        : (capturedLanded ? lastLine : (capturedPending ? capturedLine : { key: 'live', kind: 'assistant', text: '' }))))
      : (capturedPending ? capturedLine : (lastLine ?? fallback))
  const speaker = currentLine !== null ? speakerFor(scene, currentLine.kind) : speakerFor(scene, 'assistant')

  // ---- 台词分页（Galgame 点击翻页）----
  // 定稿（非流式）且超出文本框容量的文本按页拆分；流式期间不翻页（钉住开头实时打字）。
  const dtextSceneEl = scene.elements.find(el => el.type === 'dialogue-text' && !el.hidden) ?? null
  const fullText = currentLine !== null ? currentLine.text : ''
  // 恢复待定门：挂载后、分页测量与阅读状态恢复完成前禁止保存进度，
  // 否则恢复前的初始状态（页码 0/空文本）会覆盖旧进度。
  const restorePendingRef = useRef(true)
  // 分页归属：pages 在测量完成后才与当前全文绑定；此前旧页/空页不作为打字目标（不闪错页）。
  const pagesTextRef = useRef(null)
  useEffect(() => {
    restorePendingRef.current = true
    setPages([])
    setPageIndex(0)
    if (running || currentLine === null || currentLine.text === '' || dtextSceneEl === null) {
      restorePendingRef.current = false
      return
    }
    let cancelled = false
    const measure = () => {
      const measurer = createFitsMeasurer({
        width: dtextSceneEl.w,
        height: dtextSceneEl.h,
        fontSize: dtextSceneEl.fontSize,
        fontFamily: dtextSceneEl.fontFamily,
      })
      const nextPages = splitPages(currentLine.text, prefix => measurer.fits(prefix))
      measurer.dispose()
      if (cancelled) return
      restorePendingRef.current = false
      setPages(nextPages)
      pagesTextRef.current = currentLine.text
      // 流式 → 定稿无缝衔接（优先于重挂载恢复）：第一页沿用流式打字进度（不闪空）；
      // 流式期间已打满第一页则直接完整显示（不重打，点击照常翻下一页）。
      // 必须先于恢复分支：完成窗口内的保存会把 lineKey 写成定稿节点键，
      // 恢复分支会误判成重挂载并按旧进度重置（第一页重打）。
      const streamed = streamedTypeRef.current
      // 锚定「已打出的可见前缀」而非完整流式目标：真实运行时定稿节点文本
      // 与流式全文可能存在分段差异（startsWith(target) 会失配导致第一页重打）。
      // 命中后保留快照（不置空）：定稿后节点列表会短暂回退（settled→running 振荡），
      // 回退窗口靠 capturedPending 钉住正文；节点重新落地时再次衔接（幂等）。
      if (streamed !== null
        && typeof streamed.target === 'string'
        && streamed.target !== ''
        && typeof streamed.shown === 'string'
        && currentLine.text.startsWith(streamed.shown)) {
        const page = nextPages[0] ?? currentLine.text
        if (page.startsWith(streamed.shown)) {
          setType({ target: page, shown: streamed.shown, done: streamed.shown === page })
        } else {
          setType({ target: page, shown: page, done: true })
        }
        return
      }
      // 阅读状态恢复：同一行重挂载时回到原页码与打字进度（不从头渲染）。
      const stored = readStateRef.current
      if (stored.lineKey === currentLine.key && restoredKeyRef.current !== currentLine.key) {
        restoredKeyRef.current = currentLine.key
        const idx = Math.min(stored.pageIndex, nextPages.length - 1)
        setPageIndex(idx)
        const page = nextPages[idx] ?? currentLine.text
        const keep = page.startsWith(stored.shown) ? stored.shown : ''
        setType({ target: page, shown: keep, done: keep === page })
      }
    }
    // 测量放在宏任务：让测量元素先进入文档流，避免同帧布局未结算。
    const timer = setTimeout(measure, 0)
    // 自定义字体就绪后重新测量（@font-face 未加载完成时按回退字体测量会分错页）。
    if (typeof document !== 'undefined' && typeof document.fonts !== 'undefined' && document.fonts.ready !== undefined) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [running, fullText, dtextSceneEl])

  // 定稿且分页测量未完成时维持当前文本目标（衔接流式打字，不闪空不闪错页）；流式期间实时从头打字。
  const pagesReady = !running && pages.length > 0 && pagesTextRef.current === fullText
  const pageText = pagesReady
    ? (pages[Math.min(pageIndex, pages.length - 1)] ?? '')
    : fullText
  const hasNextPage = pagesReady && pageIndex < pages.length - 1
  // 流式期间与分页测量未完成时钉住文本框开头（维持画面，不闪动不追底）。
  const pinScroll = running || (dtextSceneEl !== null && !pagesReady)
  // 省略号为独立渲染标签（紧贴文本，不计入打字目标/历史/分页数据）。
  const typedTarget = pageText

  // ---- 阅读状态保存/恢复 ----
  // 关键变化点（换行/翻页/打字完成/滞留起点/状态页开关）写入会话级 store。
  // 恢复待定期间跳过保存（初始状态会覆盖旧进度）。
  // 运行中滞留玩家行时（含已换到状态页）统一按玩家行键保存，保证重挂载能对上恢复。
  const restoreKey = running && pendingPlayer !== null
    ? pendingPlayer.key
    : (currentLine?.key ?? null)
  useEffect(() => {
    if (restorePendingRef.current) return
    if (restoreKey === null) return
    actions.saveProgress({
      lineKey: restoreKey,
      pageIndex,
      shown: type.shown,
      done: type.done,
      dwellSince,
      statusHold,
    })
  }, [restoreKey, pageIndex, type.done, dwellSince, statusHold, actions])
  // 卸载（切标签页）时保存最新打字进度。
  const saveRef = useRef(null)
  saveRef.current = { key: restoreKey, pageIndex, type, dwellSince, statusHold, actions }
  useEffect(() => () => {
    const s = saveRef.current
    if (s === null || s.key === null) return
    s.actions.saveProgress({
      lineKey: s.key,
      pageIndex: s.pageIndex,
      shown: s.type.shown,
      done: s.type.done,
      dwellSince: s.dwellSince,
      statusHold: s.statusHold,
    })
  }, [])
  // 运行中重挂载：恢复滞留进度（玩家消息打字进度/滞留起点/状态页开关），
  // 切标签页回来不从头走「用户消息 → 短暂滞留 → 模型状态」。
  const runningRestoredRef = useRef(null)
  useEffect(() => {
    if (!running || pendingPlayer === null) return
    const key = pendingPlayer.key
    const stored = readStateRef.current
    if (stored.lineKey !== key || runningRestoredRef.current === key) return
    runningRestoredRef.current = key
    const target = pendingPlayer.text
    const keep = target.startsWith(stored.shown) ? stored.shown : ''
    // 恢复状态页时直接置 done（滞留效应要求 done 才不重置 statusHold）。
    setType({ target, shown: keep, done: keep === target || stored.statusHold === true })
    if (stored.dwellSince !== null && stored.dwellSince !== undefined) setDwellSince(stored.dwellSince)
    if (stored.statusHold === true) setStatusHold(true)
  }, [running, pendingPlayer])

  // 目标文本变化 → 重设打字机（自动播放不再即时跳字：按正常速度继续打字，打完自动翻页）。
  useEffect(() => {
    setType(t => setTarget(t, typedTarget))
  }, [typedTarget])

  // 自动播放：当前页显示完毕后，短暂停留自动翻下一页（下一页同样逐字打出/自动追平）。
  useEffect(() => {
    if (!auto || !type.done || running || !hasNextPage) return
    const timer = setTimeout(() => { setPageIndex(pageIndex + 1) }, 1500)
    return () => { clearTimeout(timer) }
  }, [auto, type.done, running, hasNextPage, pageIndex])

  // （pendingPlayer 判定基于 liveText 是否到达，无需完成记录状态。）

  // rAF 驱动打字机（done 后停止；advance 无变化返回同引用，React 自动跳过渲染）。
  const speed = SPEEDS[scene.settings.typeSpeed] ?? SPEEDS.normal
  useEffect(() => {
    if (type.done) return
    let raf = 0
    let last = performance.now()
    const loop = now => {
      const dt = now - last
      last = now
      setType(t => advance(t, dt, speed))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf) }
  }, [type.done, speed])

  const skipTyping = useCallback(() => { setType(t => skip(t)) }, [])

  // 快进（skip 按钮）：AI 运行中 → 追平当前页；定稿 → 直接跳到当前对话最后一页并完整显示。
  const skipAll = useCallback(() => {
    if (running) {
      setType(t => skip(t))
      return
    }
    if (pagesReady && pages.length > 0) {
      const last = pages.length - 1
      const page = pages[last] ?? ''
      setPageIndex(last)
      setType({ target: page, shown: page, done: true })
      return
    }
    setType(t => skip(t))
  }, [running, pagesReady, pages])

  // 点击文本框：打字中 → 追平当前页；已打完且有下一页 → 翻页（下一页同样逐字打出）。
  const onTextClick = useCallback(() => {
    if (running) {
      skipTyping()
      return
    }
    setType(t => (t.done ? t : skip(t)))
    if (type.done && hasNextPage) {
      setPageIndex(pageIndex + 1)
    }
  }, [running, type.done, hasNextPage, pageIndex, skipTyping])
  const send = useSend(inputActions, draft, () => setSharedDraft(''))

  // 透明功能按钮：历史/自动/快进/设置/存档/读档（原底部控制栏已移除，功能由场景内按钮承载）。
  // 动作名归一化（容忍常见别名/中文），点击即分发。
  const handleAction = useCallback(action => {
    const key = String(action ?? '').trim().toLowerCase()
    switch (key) {
      case 'history': setHistoryOpen(o => !o); break
      case 'auto': setAuto(a => !a); break
      case 'skip':
      case 'fast': skipAll(); break
      case 'settings':
      case 'config': setSettingsOpen(o => !o); break
      case 'save':
      case 'saves':
      case '存档': setSaveMode('save'); break
      case 'load':
      case 'loads':
      case '读档':
      case '读取': setSaveMode('load'); break
      default: break
    }
  }, [skipAll])

  const line = currentLine !== null ? { ...currentLine, speaker } : null
  // 输入框默认语句：以 AI 名牌名为准（名牌元素缺失时回退助手角色名）。
  const aiDisplayName = useMemo(() => assistantDisplayName(scene), [scene])
  const inputPlaceholder = '你想和' + aiDisplayName + '说什么呢？'
  // 背景由舞台 cover 模式铺满整个视窗（第 12 轮调整），不再需要模糊延展层。

  return (
    <div className="gv-root" data-gal-view="" data-gal-mode={mode} style={rootStyle} ref={rootRef}>
      <div className="gv-topbar">
        <div className="gv-brand">
          <span className="gv-brand-mark" aria-hidden="true" />
          <span>GAL 视窗</span>
        </div>
        <div className="gv-mode-switch" role="tablist" aria-label="模式切换">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'game'}
            className={'gv-mode-btn' + (mode === 'game' ? ' is-on' : '')}
            onClick={() => setMode('game')}
          >
            游戏模式
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'editor'}
            className={'gv-mode-btn' + (mode === 'editor' ? ' is-on' : '')}
            onClick={() => setMode('editor')}
          >
            编辑模式
          </button>
        </div>
        <div className="gv-topbar-right">
          {mode === 'editor'
            ? <span className="gv-topbar-hint">编辑结果实时同步到游戏模式</span>
            : (
                <button type="button" className="gv-btn" onClick={() => setSettingsOpen(o => !o)}>
                  设置
                </button>
              )}
        </div>
      </div>

      {mode === 'game' && (
        <>
          <div className="gv-stage-area">
            <StageView
              scene={scene}
              assetsMap={assets.map}
              mode="game"
              line={line}
              type={type}
              running={running}
              pinned={pinScroll}
              selectedId={null}
              onSelect={() => {}}
              api={undefined}
              onSkip={skipTyping}
              onTextClick={onTextClick}
              hasNextPage={hasNextPage}
              // 错误行正文已含「[错误] …」：不再叠加「出错」活动行；其余非运行状态照常显示。
              activity={running ? (showStatusPage ? shownActivity : null) : (currentLine !== null && currentLine.error === true ? null : shownActivity)}
              onAction={handleAction}
              autoOn={auto}
            />
            {/* 上下文占用指示条：覆盖层，下移 12px 贴于背景下缘与输入框之间；
                不占布局（舞台区大小不变）；pointer-events:none 不挡输入框。 */}
            {contextOccupancy !== null && (
              <div className="gv-context" aria-label="上下文占用">
                <div className="gv-context-track">
                  <div className={'gv-context-fill' + (contextOccupancy.percent >= 90 ? ' is-high' : '')} style={{ width: contextOccupancy.percent + '%' }} />
                  <span className="gv-context-whale" style={{ left: contextOccupancy.percent + '%' }} aria-hidden="true">🐳</span>
                </div>
                <span className="gv-context-num">{contextOccupancy.percent}%</span>
              </div>
            )}
          </div>
          {/* 决策面板：等待批准/回答时浮于舞台上方，直接作答，无需切回「对话」栏。
              提问期间底部输入行隐藏（作答全部发生在面板的选项列表与输入组合框内）。
              输入行始终挂载（仅 visibility 隐藏）：舞台区布局零变化，不分页缩放/闪烁。 */}
          <PendingPanel pending={pending} draft={draft} setSharedDraft={setSharedDraft} onControl={setQuestionControl} />
          <form
            className={'gv-input' + (questionControl !== null ? ' is-hidden' : '')}
            onSubmit={e => {
              e.preventDefault()
              send()
            }}
          >
            <textarea
              className="gv-input-box"
              value={draft}
              onChange={e => setSharedDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={inputPlaceholder}
              rows={2}
              aria-label="玩家输入"
            />
            <button type="submit" className="gv-btn gv-btn-accent gv-send" disabled={draft.trim() === ''}>
              发送
            </button>
          </form>
        </>
      )}

      {mode === 'editor' && (
        <Editor
          scene={scene}
          api={api}
          history={history}
          assetsMap={assets.map}
          fontsMap={fonts.map}
          onExitEditor={() => setMode('game')}
        />
      )}

      {historyOpen && <HistoryPanel scene={scene} lines={lines} onClose={() => setHistoryOpen(false)} />}
      {settingsOpen && <SettingsPanel scene={scene} api={api} onClose={() => setSettingsOpen(false)} />}
      {saveMode !== null && <SavePanel api={api} mode={saveMode} onClose={() => setSaveMode(null)} running={running} />}
    </div>
  )
}
