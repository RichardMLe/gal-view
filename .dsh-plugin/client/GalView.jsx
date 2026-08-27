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
function SettingsPanel({ scene, api, onClose, autoSaveStatus }) {
  const beforeRef = useRef(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
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
  // 诊断:单步执行自动存档全流程,结果直接显示(定位"不生效"卡在哪一步)。
  const runTestAutoSave = async () => {
    if (testing) return
    setTesting(true)
    setTestResult('正在测试自动存档…')
    try {
      if (typeof api?.performFileSave !== 'function') throw new Error('当前环境不支持存档')
      const result = await api.performFileSave({
        auto: true,
        skipZip: true,
        guardCheck: async () => {
          const id = api.currentSessionId()
          const t = typeof api?.captureTranscript === 'function' ? await api.captureTranscript(id) : null
          return { sessionId: id, turns: t !== null ? t.turns : null }
        },
      })
      if (result.ok) setTestResult('测试成功:已创建自动档「' + result.title + '」(工程 .gal-view-saves)')
      else setTestResult('测试未成功,原因:' + String(result.reason ?? '未知'))
    } catch (cause) {
      setTestResult('测试失败:' + causeText(cause))
    }
    setTesting(false)
  }
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
      <p className="gv-settings-hint">每完成 N 次对话自动创建「自动」存档（0 = 关闭）；自动存档仅保留最新一个。存档保存为工程目录 .gal-view-saves 下的文件（首次使用请在存档面板选择工程文件夹）；读档按存档点还原多轮对话，测试期旧对话保留不销毁。</p>
      {(typeof scene.settings.autoSaveEvery === 'number' && scene.settings.autoSaveEvery > 0 && scene.settings.autoSaveEvery <= 2) && (
        <p className="gv-settings-hint">提示：间隔过小会频繁导出完整日志，建议 ≥5（仅建议，不强制）。</p>
      )}
      {autoSaveStatus !== null && autoSaveStatus !== undefined && (
        <p className="gv-settings-hint">
          自动存档状态：
          {autoSaveStatus.lastResult === null || autoSaveStatus.lastResult === undefined
            ? '尚未触发'
            : autoSaveStatus.lastResult === 'ok'
              ? '上次成功 ' + formatTime(autoSaveStatus.lastAt)
              : '上次 ' + String(autoSaveStatus.lastResult) + (autoSaveStatus.lastReason !== '' ? '（' + String(autoSaveStatus.lastReason) + '）' : '')}
          {typeof autoSaveStatus.every === 'number' && autoSaveStatus.every > 0
            ? ' · 回合 ' + (autoSaveStatus.turns ?? 0) + ' / 基线 ' + (autoSaveStatus.baseline ?? 0) + ' / 间隔 ' + autoSaveStatus.every + '（距下次还需 ' + Math.max(0, autoSaveStatus.every - Math.max(0, (autoSaveStatus.turns ?? 0) - (autoSaveStatus.baseline ?? 0))) + ' 轮）'
            : ''}
        </p>
      )}
      <label className="gv-settings-row">
        <span>自动存档测试</span>
        <button type="button" className="gv-btn" disabled={testing} onClick={runTestAutoSave}>
          {testing ? '测试中…' : '立即存档一次'}
        </button>
      </label>
      {testResult !== null && <p className="gv-settings-hint">{testResult}</p>}
    </div>
  )
}

/** 存档/读档面板：快照式（经典 galgame 语义）。
 * SAVE = 当前会话最后已完成回合冻结为快照槽（xx-saveN / xx-自动N），永不改变；
 * LOAD = 从槽派生新世界线 → 切换 → 销毁旧世界线（归档，列表消失）。
 * 宿主不支持会话服务时给出可读提示，不抛错。 */
function SavePanel({ api, mode, onClose, running, onRequestSave, onLoaded }) {
  const [index, setIndex] = useState(null)
  const [legacy, setLegacy] = useState(() => loadSaveIndex(api))
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [dirInfo, setDirInfo] = useState(null)
  const [authPrompt, setAuthPrompt] = useState(false)
  const [migrating, setMigrating] = useState(null)
  const refresh = useCallback(async () => {
    setLegacy(loadSaveIndex(api))
    if (typeof api?.listFileSlots !== 'function') { setIndex(null); return }
    try {
      setIndex(await api.listFileSlots())
    } catch {
      setIndex(null)
    }
    if (typeof api?.saveDirInfo === 'function') {
      try { setDirInfo(await api.saveDirInfo()) } catch { setDirInfo(null) }
    }
  }, [api])
  useEffect(() => {
    void refresh()
    if (typeof api?.onSessions !== 'function') return
    return api.onSessions(() => { void refresh() })
  }, [api, refresh])
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    // 存档进行中忽略 Escape:手动存档必须完整结束后才能继续对话。
    const onKey = e => { if (e.key === 'Escape' && busyRef.current !== true) onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const pickDir = async () => {
    if (picking || busy) return
    setPicking(true)
    setError(null)
    try {
      if (typeof api?.ensureSaveDir !== 'function') throw new Error('当前环境不支持文件夹写入')
      const ok = await api.ensureSaveDir()
      if (!ok) setNotice('已取消选择')
      await refresh()
    } catch (cause) {
      setError(causeText(cause))
    }
    setPicking(false)
  }
  const save = async () => {
    if (busy) return
    if (typeof onRequestSave !== 'function') {
      setError('当前环境不支持存档')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setNotice('正在存档：等待回合落定、导出完整日志…（请勿继续对话）')
      const result = await onRequestSave()
      setNotice(result !== null && result.fallback === true
        ? '已下载存档文件（此环境不支持文件夹写入，请把文件放进工程 .gal-view-saves 文件夹）'
        : '已创建存档「' + result.title + '」（永久保存，读档也不会改变它）')
      setAuthPrompt(false)
      await refresh()
    } catch (cause) {
      if (cause !== null && typeof cause === 'object' && cause.code === 'dir-unauthorized') {
        setError(null)
        setNotice(null)
        setAuthPrompt(true)
      } else {
        setError(causeText(cause))
        setNotice(null)
      }
    }
    setBusy(false)
  }
  const load = async (id) => {
    if (busy || running === true) return
    setBusy(true)
    setError(null)
    try {
      if (typeof api?.loadSaveFile !== 'function') throw new Error('当前环境不支持文件读档')
      const result = await api.loadSaveFile(id)
      if (typeof onLoaded === 'function') onLoaded(result)
      onClose()
    } catch (cause) {
      setError(causeText(cause))
      setBusy(false)
    }
  }
  const remove = async (slot) => {
    if (busy) return
    if (typeof window.confirm === 'function' && !window.confirm('删除存档「' + slot.title + '」？文件将被永久删除。')) return
    setBusy(true)
    setError(null)
    setNotice('正在删除存档「' + slot.title + '」…')
    try {
      if (typeof api?.deleteSlotFile !== 'function') throw new Error('当前环境不支持删除存档')
      await api.deleteSlotFile(slot.id)
      setNotice('已删除存档「' + slot.title + '」')
      await refresh()
    } catch (cause) {
      setError(causeText(cause))
      setNotice(null)
    }
    setBusy(false)
  }
  const removeBroken = async (name) => {
    if (busy) return
    const clean = String(name).replace('(孤立日志)', '')
    if (typeof window.confirm === 'function' && !window.confirm('删除文件「' + clean + '」？')) return
    setBusy(true)
    setError(null)
    setNotice('正在删除 ' + clean + '…')
    try {
      if (typeof api?.deleteBrokenFile !== 'function') throw new Error('当前环境不支持删除')
      await api.deleteBrokenFile(name)
      setNotice('已删除 ' + clean)
      await refresh()
    } catch (cause) {
      setError(causeText(cause))
      setNotice(null)
    }
    setBusy(false)
  }
  // 旧式槽位（会话分叉式）：读档走原 fork 槽路径；改名仅手动槽。
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
      await refresh()
    } catch (cause) {
      setError(causeText(cause))
    }
  }
  const loadLegacy = async (id) => {
    if (busy || running === true) return
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
  const brokenCount = index !== null && Array.isArray(index.broken) ? index.broken.length : 0
  const renderFileSlot = (s) => (
    <div className="gv-saves-row" key={s.id}>
      <span className="gv-saves-name">{s.title}</span>
      <span className="gv-saves-time">{formatTime(s.savedAt)}{s.turns > 0 ? ' · ' + s.turns + ' 回合' : ''}</span>
      {s.auto === true && <span className="gv-saves-badge">自动</span>}
      {mode === 'load' && (
        <button type="button" className="gv-btn" disabled={busy || running === true} onClick={() => load(s.id)}>读取</button>
      )}
      {mode === 'save' && (
        <button type="button" className="gv-btn" disabled={busy} onClick={() => remove(s)}>删除</button>
      )}
    </div>
  )
  const renderLegacyRows = (slots, isAuto) => slots.map(s => {
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
          <button type="button" className="gv-btn" disabled={busy || running === true} onClick={() => loadLegacy(s.id)}>读取</button>
        )}
      </div>
    )
  })
  // 旧式存档迁移:按钮触发,面板锁定+进度;完成后清空旧槽名录(「旧式存档」分区消失)。
  const migrate = async () => {
    if (busy) return
    if (typeof api?.migrateLegacySlots !== 'function') { setError('当前环境不支持迁移'); return }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setMigrating({ done: 0, total: legacy.saves.length + legacy.autos.length })
      const result = await api.migrateLegacySlots((done, total) => setMigrating({ done, total }))
      setNotice('已将 ' + result.migrated + ' 个旧式存档迁移为新式（名称前加「旧」）')
      await refresh()
    } catch (cause) {
      if (cause !== null && typeof cause === 'object' && cause.code === 'dir-unauthorized') {
        setError('迁移需要先授权存档文件夹（点击上方「选择存档文件夹」）')
      } else {
        setError(causeText(cause))
      }
      setNotice(null)
    }
    setMigrating(null)
    setBusy(false)
  }
  const hasLegacy = legacy.saves.length > 0 || legacy.autos.length > 0
  return (
    <div className="gv-saves-layer" role="dialog" aria-label={mode === 'save' ? '存档' : '读档'}>
      <div className="gv-saves">
        <div className="gv-saves-head">
          <span>{mode === 'save' ? '存档' : '读档'}</span>
          <button type="button" className="gv-btn" disabled={busy} onClick={onClose}>关闭</button>
        </div>
        <div className="gv-saves-dir">
          <span className="gv-saves-dir-label">
            {dirInfo !== null && dirInfo.authorized === true
              ? '存档文件夹：' + (dirInfo.projectPath !== '' ? String(dirInfo.projectPath).replace(/[\\/]+$/, '') + '\\.gal-view-saves' : '工程 .gal-view-saves')
              : '存档文件夹：未授权' + (dirInfo !== null && dirInfo.projectPath !== '' ? '（工程路径：' + dirInfo.projectPath + '）' : '')}
            {dirInfo !== null && dirInfo.mismatch === true ? ' · 注意：授权目录与当前工程不一致' : ''}
          </span>
          <button type="button" className="gv-btn" disabled={picking || busy} onClick={pickDir}>
            {picking ? '选择中…' : (dirInfo !== null && dirInfo.authorized === true ? '重新选择' : '选择存档文件夹')}
          </button>
        </div>
        {authPrompt && (
          <div className="gv-saves-auth">
            <p>首次存档需要授权：请选择当前工程文件夹{dirInfo !== null && dirInfo.projectPath !== '' ? '（' + dirInfo.projectPath + '）' : ''}。浏览器不允许程序按路径直接写文件，需要你点选一次；之后将静默写入。</p>
            <div className="gv-saves-auth-actions">
              <button type="button" className="gv-btn gv-btn-gold" disabled={picking} onClick={async () => { await pickDir(); void save() }}>选择文件夹并授权</button>
              <button type="button" className="gv-btn" disabled={picking} onClick={() => setAuthPrompt(false)}>取消</button>
            </div>
          </div>
        )}
        {mode === 'save'
          ? <p className="gv-saves-hint">存档 = 把当前对话完整复制进工程 .gal-view-saves 文件夹：官方完整日志 zip + 可读记录 md（永久保存，读档不会改变它）；存档期间请勿继续对话，读档按存档点还原多轮对话。</p>
          : <p className="gv-saves-hint">读取存档 = 按存档点切出新世界线继续（测试期旧世界线保留，不销毁）。{running === true ? '当前回复尚未完成，请等它结束后再读取。' : ''}</p>}
        <div className="gv-saves-list">
          <div className="gv-saves-group">自动存档（文件）</div>
          {index !== null && index.autos.length > 0
            ? index.autos.map(renderFileSlot)
            : <div className="gv-saves-empty gv-saves-auto-empty">当前无自动存档</div>}
          <div className="gv-saves-group">手动存档（文件）</div>
          {index !== null && index.saves.length === 0 && <div className="gv-saves-empty">还没有手动存档</div>}
          {index !== null && index.saves.map(renderFileSlot)}
          {index === null && <div className="gv-saves-empty">文件存档不可用（当前浏览器环境不支持）</div>}
          {hasLegacy && (
            <div className="gv-saves-group-row">
              <span className="gv-saves-group">旧式存档（会话槽）</span>
              <button type="button" className="gv-btn" disabled={busy} onClick={migrate}>转化为新式存档</button>
            </div>
          )}
          {hasLegacy && legacy.autos.length > 0 && renderLegacyRows(legacy.autos, true)}
          {hasLegacy && legacy.saves.length > 0 && renderLegacyRows(legacy.saves, false)}
          {migrating !== null && <p className="gv-saves-notice">迁移中 {migrating.done}/{migrating.total}…（期间不可操作）</p>}
          {brokenCount > 0 && index !== null && Array.isArray(index.broken) && (
            <div className="gv-saves-broken">
              <p className="gv-saves-broken-title">{brokenCount} 个文件无法识别（不是有效的存档文件，已跳过）：</p>
              {index.broken.map(name => (
                <div className="gv-saves-broken-row" key={String(name)}>
                  <span className="gv-saves-broken-name">{String(name)}</span>
                  <button type="button" className="gv-btn" disabled={busy} onClick={() => removeBroken(name)}>删除</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {mode === 'save' && (
          <button type="button" className="gv-btn gv-btn-gold gv-saves-create" disabled={busy} onClick={save}>
            创建存档
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

/** GAL 视窗错误边界:渲染异常时显示可读错误(便于定位),而不是整个视窗空白。 */
class GalErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[gal-view] 视图渲染错误:', error, info)
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="gv-root gv-crash" data-gal-view="">
          <div className="gv-crash-box">
            <p className="gv-crash-title">GAL 视窗遇到错误</p>
            <p className="gv-crash-msg">{String(this.state.error !== null && typeof this.state.error === 'object' && this.state.error.message ? this.state.error.message : this.state.error)}</p>
            <button type="button" className="gv-btn" onClick={() => this.setState({ error: null })}>重试</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
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
export function GalView({ useSession, useInput, inputActions, useScene, useHistory, useAssets, useFonts, useStore, useProjection, useAutoSaveStatus, actions, api }) {
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
  // 自动存档状态(apply 级全局源)。必须在顶层无条件调用:条件调用 hook 会破坏
  // hook 顺序,设置面板打开时(settingsOpen 翻转)直接崩溃。
  const autoSaveStatusSnapshot = typeof useAutoSaveStatus === 'function' ? useAutoSaveStatus(s => s) : null

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
  // 内容级还原（inject 回退）的记录行：新会话无真实历史时用于展示与续写。
  const [restoredLines, setRestoredLines] = useState(null)
  const displayLines = (lines.length > 0 || restoredLines === null || restoredLines.length === 0) ? lines : restoredLines
  const lastLine = displayLines.length > 0 ? displayLines[displayLines.length - 1] : null
  // ---- 存档支持(手动存档;自动存档由 apply 级全局控制器负责,不依赖本视图挂载)----
  const sessionStats = typeof useProjection === 'function' ? useProjection('sessionStats') : undefined
  const playerTurns = useMemo(() => lines.filter(l => l.kind === 'player').length, [lines])
  const turns = typeof sessionStats?.turns === 'number' ? sessionStats.turns : playerTurns
  const autoSessionId = typeof api?.currentSessionId === 'function'
    ? (api.currentSessionId() ?? 'default')
    : (typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default')
  // 回合数(持久)供手动存档一致性守卫使用。
  const turnsRef = useRef(0)
  turnsRef.current = turns
  // 窗口记录采集(history 接口不可用时的存档回退)。
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const readRecord = useCallback(() => {
    const list = Array.isArray(nodesRef.current) ? nodesRef.current : []
    const recLines = nodesToLines(list)
    const lastNode = list[list.length - 1]
    return {
      lines: recLines,
      turns: recLines.filter(l => l.kind === 'player').length,
      atSeq: lastNode !== undefined && typeof lastNode.seq === 'number' ? lastNode.seq : null,
    }
  }, [api])
  // 对话行骤降看门狗(仅记录,不干预):同一会话内 nodes 数量骤降(>50%)且非
  // 运行中,说明官方会话窗口被重装成了不完整尾部。只打日志——自动 resync
  // 会与官方合法的尾部页重装(>50 条长对话 repairGap 只保留尾部 50 条)误判,
  // 且主动干预曾与官方状态机耦合(8-26 事故后确立:看门狗只记录、不动手)。
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
      if (now - w.last > 15000) {
        w.last = now
        console.warn('[gal-view:watchdog] 检测到对话行骤减 ' + prev + ' → ' + nodesCount + '(会话 ' + autoSessionId + ')。日志仅供诊断;如对话消失请 F5 刷新。')
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

  // ---- 文件式存档/读档 ----
  // 手动存档:轻量落定 → 待处理清空 → api.performFileSave(history 转写+zip 导出+守卫+互斥)。
  const requestSave = useCallback(async () => {
    if (Array.isArray(pending) && pending.length > 0) throw new Error('请先处理完当前的问题（批准/回答）再存档')
    // 闸门只在 sessions 服务可用时生效(等待回合结束+短暂静默)。
    const hasSvc = typeof api?.hasSessionsService === 'function' ? api.hasSessionsService() : false
    if (hasSvc && typeof api?.waitSettled === 'function') {
      const gate = await api.waitSettled({ quietMs: 1500, timeoutMs: 15000 })
      if (!gate.settled) throw new Error('回复尚未完全落定，请稍后再存档')
    }
    if (typeof api?.performFileSave !== 'function') throw new Error('当前环境不支持文件存档')
    const result = await api.performFileSave({
      auto: false,
      // 守卫与 guardBefore 同源:优先 history 转写回合数,不可用时回退窗口/投影计数。
      guardCheck: async () => {
        const id = api.currentSessionId()
        const t = typeof api?.captureTranscript === 'function' ? await api.captureTranscript(id) : null
        return { sessionId: id, turns: t !== null ? t.turns : turnsRef.current }
      },
      fallbackLines: readRecord(),
    })
    if (!result.ok) {
      if (result.reason === 'busy') throw new Error('已有存档正在进行，请稍候再试')
      if (result.reason === 'interfered') throw new Error('存档期间对话发生了变化，已取消本次存档，请重试')
      if (result.reason === 'empty') throw new Error('还没有已完成的对话，先聊两句再存档吧')
      if (result.reason === 'no-session') throw new Error('未找到当前会话')
      if (result.reason === 'capture-unavailable') throw new Error('当前环境无法读取会话记录，请重试')
      throw new Error('存档失败：' + String(result.reason ?? '未知原因'))
    }
    return result
  }, [api, pending, readRecord])
  const requestLoad = useCallback(async (id) => {
    if (typeof api?.loadSaveFile !== 'function') throw new Error('当前环境不支持文件读档')
    return api.loadSaveFile(id)
  }, [api])
  // 读档结果落地:fork 模式新会话自带真实历史;inject 回退渲染记录行并把记录放进草稿。
  const handleLoaded = useCallback((result) => {
    if (result !== null && typeof result === 'object' && result.mode === 'inject' && Array.isArray(result.lines)) {
      setRestoredLines(result.lines)
      if (typeof result.recordText === 'string' && result.recordText !== '') setSharedDraft(result.recordText)
    } else {
      setRestoredLines(null)
    }
  }, [setSharedDraft])

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
    <GalErrorBoundary>
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

      {historyOpen && <HistoryPanel scene={scene} lines={displayLines} onClose={() => setHistoryOpen(false)} />}
      {settingsOpen && <SettingsPanel scene={scene} api={api} onClose={() => setSettingsOpen(false)} autoSaveStatus={autoSaveStatusSnapshot} />}
      {saveMode !== null && <SavePanel api={api} mode={saveMode} onClose={() => setSaveMode(null)} running={running} onRequestSave={requestSave} onLoaded={handleLoaded} />}
      </div>
    </GalErrorBoundary>
  )
}
