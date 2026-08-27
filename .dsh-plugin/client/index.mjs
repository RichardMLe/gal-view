/** gal-view 浏览器 half：注册 conversation.view 槽位的 'gal' 视图。
 * 官方 bundle 插件 client 契约：经 __ModuleLoader__.load 挂载，export name/inject/apply；
 * apply 收到 client 根 ctx，用 ctx.slots.inject 等待 ui-conversation 声明后注册（
 * 卸载时随纤维自动移除标签页）。场景存储/历史/API 在 apply 闭包内构建，经
 * inject 面的 hooks 舱（scene/history 可观察源）与 api（普通回调）交付组件。
 *
 * 槽位位置：order 5 —— 「对话」(0) 与「轨迹」(10) 之间。
 */

import { CSS } from './styles.mjs'
import { GalView } from './GalView.jsx'
import { GalViewSettingsTab } from './SettingsTab.jsx'
import {
  defaultScene, normalizeScene, cloneScene, makeElement, makeId, sortElements,
  ELEMENT_TYPES, ensureDialogueText, ensureSpeakerNames, ensureActionButtons,
  ensureBackgroundCover, ensureSaveButtonLayout,
} from './scene.mjs'
import {
  ASSET_MIME, MAX_ASSET_BYTES, normalizeAsset, readFileAsDataUrl, measureImage,
  embedAssets, extractAssets, createIdbAssets,
} from './assets.mjs'
import {
  MAX_FONT_BYTES, FONT_FORMATS, normalizeFont, buildFontFace, fontFamilyFromName,
  extOf, embedFonts, extractFonts, createIdbFonts,
} from './fonts.mjs'
import { createObservable, createHistory, createStorage, loadJSON, saveJSON } from './store.mjs'
import { saveRootPrefix, rootOf, nextSaveTitle, nextAutoTitle, isValidSlotTitle } from './save.mjs'
import { waitSettled } from './settle.mjs'
import {
  buildSaveDoc, parseSaveDoc, linesToText, slotIdFromFileName, slotFromFileName,
  nextFileSlotId, fileSlotPrefix, isAncestorOf,
} from './savefile.mjs'
import {
  fsAccessSupported, pickDirectory, resolveSaveDir, loadDirHandle, listSaveFiles,
  writeSaveFile, readSaveFile, removeSaveFile, downloadTextFile,
  writeSaveZip, downloadBlobFile, withTimeout,
} from './fsaccess.mjs'
import { wireEventsToLines } from './transcript-log.mjs'
import { createGlobalAutoSave } from './autosave.mjs'
import { assistantDisplayName } from './transcript.mjs'
// 默认预设场景：仓库根 gal-scene.json（编辑器导出的格式，内嵌被引用的素材/字体）。
import presetScene from '../../gal-scene.json'

export const name = 'gal-view'

/** 依赖服务：槽位系统（会话数据经槽位框架注入，无需直接消费 sessions）。 */
export const inject = ['slots']

const PERSIST_KEY = 'gal-view:scene:v1'
const ENABLED_KEY = 'gal-view:enabled'
const HISTORY_LIMIT = 100

/**
 * 每会话阅读状态（经槽位 store 声明，框架按会话调用 create(scopeKey) 实例化）：
 * 标签页切换/刷新后恢复当前行、页码与打字进度，对话不再从头渲染。
 * 手写 handle 契约（spec + create），避免引入 runtime 模块依赖。
 */
function createReadStore() {
  return {
    spec: {
      init: () => ({ lineKey: null, pageIndex: 0, shown: '', done: true, dwellSince: null, statusHold: false }),
      persist: 'gal-view.read',
      actions: {
        saveProgress: (draft, progress) => {
          draft.lineKey = progress.lineKey
          draft.pageIndex = progress.pageIndex
          draft.shown = progress.shown
          draft.done = progress.done
          draft.dwellSince = progress.dwellSince
          draft.statusHold = progress.statusHold
        },
      },
    },
    create(scopeKey) {
      const persistKey = scopeKey === undefined
        ? 'gal-view.read'
        : 'gal-view.read.' + String(scopeKey)
      let state = { lineKey: null, pageIndex: 0, shown: '', done: true, dwellSince: null, statusHold: false }
      try {
        const raw = window.localStorage.getItem(persistKey)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') state = parsed
        }
      } catch {
        // 隐私模式/坏数据：用初始状态。
      }
      const listeners = new Set()
      const persist = () => {
        try { window.localStorage.setItem(persistKey, JSON.stringify(state)) } catch { /* 忽略 */ }
      }
      return {
        getSnapshot: () => state,
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        actions: {
          saveProgress(progress) {
            state = {
              lineKey: progress.lineKey,
              pageIndex: progress.pageIndex,
              shown: progress.shown,
              done: progress.done,
              dwellSince: progress.dwellSince,
              statusHold: progress.statusHold === true,
            }
            persist()
            for (const fn of [...listeners]) fn()
          },
        },
        clearPersisted() {
          try { window.localStorage.removeItem(persistKey) } catch { /* 忽略 */ }
        },
      }
    },
  }
}

/** 场景 API 工厂：所有变更实时写 sceneSource；历史栈承载可撤销快照；素材/字体库读写 IDB。
 * sessionsSvc 可选：客户端 sessions 服务(ctx.get('sessions'))——分叉存档(SAVE=分叉、
 * LOAD=切换)依赖它；workspacesSvc 可选：工作区服务(ctx.get('workspaces'))——
 * archiveSession 在它上面(不在 sessions 上)。connectionSvc 可选：客户端连接服务
 * (ctx.get('connection'))——官方 history RPC(captureTranscript)依赖它。缺失时相关方法降级。 */
function createSceneApi(sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase, sessionsSvc, workspacesSvc, connectionSvc) {
  const current = () => sceneSource.getSnapshot()
  /** 存档互斥锁(自动/手动共用;同一时刻只有一份存档在跑)。 */
  let saveLocked = false

  const commit = next => {
    sceneSource.update(next)
    saveJSON(storage, PERSIST_KEY, next)
  }

  const snapshotScene = () => cloneScene(current())

  const commitHistory = before => {
    if (before === undefined || before === null) return
    const now = current()
    if (JSON.stringify(now) === JSON.stringify(before)) return
    history.push(before)
    historySource.update(history.info())
  }

  const pushAndCommit = next => {
    const before = snapshotScene()
    commit(next)
    history.push(before)
    historySource.update(history.info())
  }

  return {
    /** 快照当前场景（拖动/属性编辑起手）。 */
    snapshotScene,

    /** 实时更新单个元素（不写历史）。 */
    updateElement(id, patch) {
      commit({
        ...current(),
        elements: current().elements.map(el => (el.id === id ? { ...el, ...patch } : el)),
      })
    },

    /** 实时更新设置（浅合并进 settings；不写历史）。 */
    updateSettings(patch) {
      commit({
        ...current(),
        settings: { ...current().settings, ...patch },
      })
    },

    /** 以起手快照提交一次历史（无变化则跳过）。 */
    commitHistory,

    /** 添加元素（自带历史），返回新 id。 */
    addElement(type, opts = {}) {
      if (!ELEMENT_TYPES.includes(type)) return null
      const s = current()
      const index = opts.index ?? s.elements.filter(el => el.type === type).length
      const el = makeElement(type, {
        id: opts.id,
        index,
        role: opts.role,
        stageW: s.settings.stageW,
        stageH: s.settings.stageH,
      })
      pushAndCommit({ ...s, elements: [...s.elements, el] })
      return el.id
    },

    /** 删除元素（自带历史）。 */
    removeElement(id) {
      const s = current()
      pushAndCommit({ ...s, elements: s.elements.filter(el => el.id !== id) })
    },

    /** 复制元素（自带历史），返回副本 id。 */
    duplicateElement(id) {
      const s = current()
      const src = s.elements.find(el => el.id === id)
      if (src === undefined) return null
      const copy = {
        ...cloneScene(src),
        id: makeId('el'),
        name: src.name + ' 副本',
        x: src.x + 16,
        y: src.y + 16,
        z: src.z + 1,
        locked: false,
      }
      pushAndCommit({ ...s, elements: [...s.elements, copy] })
      return copy.id
    },

    /** 图层操作：up/down 交换相邻 z；top/bottom 置为极值。 */
    reorderElement(id, dir) {
      const s = current()
      const sorted = sortElements(s.elements)
      const at = sorted.findIndex(el => el.id === id)
      if (at < 0) return
      const target = sorted[at]
      let z = target.z
      if (dir === 'up' && at < sorted.length - 1) z = sorted[at + 1].z + 0
      else if (dir === 'down' && at > 0) z = sorted[at - 1].z
      else if (dir === 'top') z = (sorted[sorted.length - 1]?.z ?? 0) + 1
      else if (dir === 'bottom') z = (sorted[0]?.z ?? 0) - 1
      if (z === target.z && dir !== 'top' && dir !== 'bottom') {
        // up/down 交换 z
        const other = dir === 'up' ? sorted[at + 1] : sorted[at - 1]
        if (other === undefined) return
        const zA = target.z
        const zB = other.z
        pushAndCommit({
          ...s,
          elements: s.elements.map(el => {
            if (el.id === target.id) return { ...el, z: zB }
            if (el.id === other.id) return { ...el, z: zA }
            return el
          }),
        })
        return
      }
      pushAndCommit({
        ...s,
        elements: s.elements.map(el => (el.id === id ? { ...el, z } : el)),
      })
    },

    /** 导入场景（归一化 + 自带历史；内嵌素材先还原进素材库）。 */
    replaceScene(raw) {
      const next = normalizeScene(raw)
      if (next === null) return false
      const embedded = extractAssets(raw)
      if (embedded.length > 0) {
        const map = new Map(assetsSource.getSnapshot().map)
        for (const record of embedded) {
          map.set(record.id, record)
          void idb.put(record).catch(() => {})
        }
        assetsSource.update({ map })
      }
      const embeddedFonts = extractFonts(raw)
      if (embeddedFonts.length > 0) {
        const map = new Map(fontsSource.getSnapshot().map)
        for (const record of embeddedFonts) {
          map.set(record.id, record)
          void fontIdb.put(record).catch(() => {})
        }
        fontsSource.update({ map })
      }
      pushAndCommit(next)
      return true
    },

    /** 重置为默认预设场景（自带历史；预设素材同步还原进库）。 */
    resetScene() {
      seedPresetAssets()
      pushAndCommit(presetBase())
    },

    /** 撤销 / 重做（真正的 history stack）。 */
    undo() {
      const prev = history.undoStep(snapshotScene())
      if (prev === null) return
      commit(prev)
      historySource.update(history.info())
    },
    redo() {
      const next = history.redoStep(snapshotScene())
      if (next === null) return
      commit(next)
      historySource.update(history.info())
    },

    /** 导出场景 JSON：内嵌被引用的素材与字体 dataURL（组件负责 Blob 下载）。 */
    exportScene() {
      const withAssets = embedAssets(current(), assetsSource.getSnapshot().map)
      return JSON.stringify(embedFonts(withAssets, fontsSource.getSnapshot().map), null, 2)
    },

    /** 素材库：导入图片文件（多选；跳过非图片/超限/损坏项）。 */
    async importAssets(files) {
      const list = Array.isArray(files) ? files : []
      let added = 0
      let skipped = 0
      const ids = []
      for (const file of list) {
        const type = file !== null && typeof file === 'object' ? file.type : ''
        const size = file !== null && typeof file === 'object' ? file.size : Infinity
        if (typeof type !== 'string' || !ASSET_MIME.test(type) || typeof size !== 'number' || size > MAX_ASSET_BYTES) {
          skipped += 1
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const { width, height } = await measureImage(dataUrl)
          const record = normalizeAsset({
            id: makeId('asset'),
            name: typeof file.name === 'string' && file.name !== '' ? file.name : '素材',
            mime: type,
            dataUrl,
            width,
            height,
            createdAt: Date.now(),
          })
          if (record === null) {
            skipped += 1
            continue
          }
          await idb.put(record)
          const map = new Map(assetsSource.getSnapshot().map)
          map.set(record.id, record)
          assetsSource.update({ map })
          ids.push(record.id)
          added += 1
        } catch (error) {
          console.warn('[gal-view] 素材导入失败：' + String(error?.message ?? error))
          skipped += 1
        }
      }
      return { added, skipped, ids }
    },

    /** 素材库：删除素材并清除所有元素引用（一次性历史）。 */
    async removeAsset(id) {
      const map = new Map(assetsSource.getSnapshot().map)
      if (!map.has(id)) return false
      map.delete(id)
      assetsSource.update({ map })
      void idb.remove(id).catch(() => {})
      const s = current()
      if (s.elements.some(el => el.image === id)) {
        pushAndCommit({ ...s, elements: s.elements.map(el => (el.image === id ? { ...el, image: null } : el)) })
      }
      return true
    },

    /** 素材记录查询（组件渲染用；缺失返回 null → 占位图形）。 */
    asset(id) {
      if (typeof id !== 'string' || id === '') return null
      return assetsSource.getSnapshot().map.get(id) ?? null
    },

    /** 字体库：导入字体文件（多选；跳过非字体/超限/损坏项）。 */
    async importFonts(files) {
      const list = Array.isArray(files) ? files : []
      let added = 0
      let skipped = 0
      const ids = []
      for (const file of list) {
        if (file === null || typeof file !== 'object') { skipped += 1; continue }
        const ext = extOf(typeof file.name === 'string' ? file.name : '')
        const format = FONT_FORMATS[ext]
        const mimeOk = typeof file.type === 'string' && /font\/(ttf|otf|woff2?)/i.test(file.type)
        if (format === undefined && !mimeOk) { skipped += 1; continue }
        const size = typeof file.size === 'number' ? file.size : Infinity
        if (size > MAX_FONT_BYTES) { skipped += 1; continue }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const baseFamily = fontFamilyFromName(typeof file.name === 'string' ? file.name : '')
          const existing = [...fontsSource.getSnapshot().map.values()]
          let family = baseFamily
          let n = 1
          while (existing.some(record => record.family.toLowerCase() === family.toLowerCase())) {
            n += 1
            family = baseFamily + '-' + n
          }
          const record = normalizeFont({
            id: makeId('font'),
            name: typeof file.name === 'string' && file.name !== '' ? file.name : '字体',
            family,
            format: format ?? 'truetype',
            dataUrl,
            createdAt: Date.now(),
          })
          if (record === null) { skipped += 1; continue }
          await fontIdb.put(record)
          const map = new Map(fontsSource.getSnapshot().map)
          map.set(record.id, record)
          fontsSource.update({ map })
          ids.push(record.id)
          added += 1
        } catch {
          skipped += 1
        }
      }
      return { added, skipped, ids }
    },

    /** 字体库：删除字体（元素引用保留 family 字符串，缺失时浏览器自然回退）。 */
    async removeFont(id) {
      const map = new Map(fontsSource.getSnapshot().map)
      if (!map.has(id)) return false
      map.delete(id)
      fontsSource.update({ map })
      void fontIdb.remove(id).catch(() => {})
      return true
    },

    /** 字体记录查询（组件渲染用）。 */
    font(id) {
      if (typeof id !== 'string' || id === '') return null
      return fontsSource.getSnapshot().map.get(id) ?? null
    },

    // ---- 快照式存档（会话级） ----
    // SAVE：fork(当前会话) → 冻结快照槽（xx-saveN / xx-自动N），随后归档——槽位不出现在
    //   工作区会话列表（归档不删数据，读档仍可 fork）；槽位名录持久化在 localStorage 注册表，
    //   不依赖会话列表快照。
    // LOAD：fork(槽) → 新世界线 → 切过去 → 新线改回主线程原名 → 归档旧世界线。
    hasSessionsService() {
      return sessionsSvc !== undefined && sessionsSvc !== null
        && typeof sessionsSvc.fork === 'function'
        && typeof sessionsSvc.open === 'function'
    },
    currentSessionId() {
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      return typeof snapshot?.current === 'string' ? snapshot.current : null
    },
    /** 主线程标题：沿当前会话父链上溯到根（byId 缺失时回退当前会话标题）。 */
    rootTitleOf(current, byId) {
      const rootId = rootOf(byId, current)
      const title = byId?.[rootId]?.title
      return typeof title === 'string' && title !== '' ? title : (byId?.[current]?.title ?? '')
    },
    /** 读/写槽位注册表（localStorage；归档后会话列表不可见，名录必须自持）。
     * 读取即过滤：自动存档仅保留最新一条（旧版本遗留的多条自动档在界面上直接消失，
     * 不涉及任何物理删除）。 */
    readSlotsRegistry() {
      try {
        const raw = storage?.getItem?.(SLOTS_KEY) ?? null
        if (raw === null) return { rootTitle: '', saves: [], autos: [] }
        const parsed = JSON.parse(raw)
        const saves = Array.isArray(parsed.saves) ? parsed.saves : []
        const autos = Array.isArray(parsed.autos) ? parsed.autos : []
        return {
          rootTitle: typeof parsed.rootTitle === 'string' ? parsed.rootTitle : '',
          saves,
          autos: autos.length > 0 ? [autos[autos.length - 1]] : [],
        }
      } catch {
        return { rootTitle: '', saves: [], autos: [] }
      }
    },
    writeSlotsRegistry(reg) {
      try {
        storage?.setItem?.(SLOTS_KEY, JSON.stringify(reg))
      } catch {
        // 隐私模式/配额：忽略（名录仅本会话有效）。
      }
    },
    /** 面板数据：注册表名录 + 主线程标题（以注册表为准，父链解析兜底）。 */
    saveIndex() {
      const reg = this.readSlotsRegistry()
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      let rootTitle = reg.rootTitle
      if (current !== null) {
        const byId = snapshot?.byId ?? {}
        const own = byId?.[current]?.title
        if (typeof own === 'string' && own !== '' && !isSlotTitle(own)) {
          rootTitle = own
        } else {
          const chained = this.rootTitleOf(current, byId)
          if (chained !== '' && !isSlotTitle(chained)) rootTitle = chained
        }
      }
      return { rootId: current, rootTitle, saves: reg.saves, autos: reg.autos }
    },
    /** 归档一个会话（archiveSession 在 workspaces 服务上；sessions 服务没有）。
     * 护栏：官方在「当前会话被归档」时会直接 clear 当前选择（对话栏整个空白），
     * 因此目标 id 是当前会话时直接拒绝，绝不冒险。 */
    async archiveSessionQuiet(sessionId) {
      if (this.currentSessionId() === sessionId) {
        console.warn('[gal-view:save] 拒绝归档当前会话(官方会因此清空对话):', sessionId)
        return false
      }
      const op = workspacesSvc?.archiveSession ?? sessionsSvc?.archiveSession
      if (typeof op === 'function') {
        try {
          await op.call(workspacesSvc?.archiveSession !== undefined ? workspacesSvc : sessionsSvc, sessionId)
          return true
        } catch {
          // 归档失败不阻断：旧会话残留可在官方列表手动归档
        }
      }
      return false
    },
    /** 落定闸门：等主机摘要 running=false 且连续 quietMs 无列表变化。
     * 返回 { settled, completed, aborted }；服务缺失时 settled=false。 */
    async waitSettled(opts = {}) {
      const list = sessionsSvc?.list
      if (list === null || list === undefined || typeof list.getSnapshot !== 'function') {
        return { settled: false, completed: false, aborted: false }
      }
      return waitSettled({
        getSnapshot: () => list.getSnapshot(),
        subscribe: typeof list.subscribe === 'function' ? cb => list.subscribe(cb) : null,
        quietMs: typeof opts.quietMs === 'number' ? opts.quietMs : 2500,
        timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000,
        shouldContinue: typeof opts.shouldContinue === 'function' ? opts.shouldContinue : undefined,
      })
    },
    /** 轮询等待 list.current 变为指定 id（读档切换落地确认；上限 timeoutMs）。 */
    async waitCurrentIs(id, timeoutMs = 2000) {
      const started = Date.now()
      for (;;) {
        if (this.currentSessionId() === id) return true
        if (Date.now() - started >= timeoutMs) return this.currentSessionId() === id
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    },
    /** 重装当前会话窗口（看门狗用）：官方窗口被重装成不完整尾部时，
     * resync 重置窗口并重拉基线（open 在已打开时是 no-op，不能恢复）。 */
    async reopenCurrent() {
      const id = this.currentSessionId()
      if (id === null) return false
      try {
        const session = sessionsSvc?.binding?.(id)?.session ?? null
        if (session !== null) {
          if (typeof session.resync === 'function') {
            await session.resync()
            return true
          }
          if (typeof session.open === 'function') {
            await session.open()
            return true
          }
        }
      } catch (cause) {
        console.warn('[gal-view:watchdog] 重装会话窗口失败:', cause)
      }
      return false
    },
    /** 记录一次存档操作（看门狗据此判断"官方清空当前选择"是否是我们引发的）。 */
    noteSaveOp() {
      this._noteSaveOp?.()
    },
    /** 快照式创建：fork 当前会话 + 命名 + 归档 + 入名录。
     * 调用方必须先过落定闸门（waitSettled）——对未落定的活跃会话 fork 会
     * 打断官方会话窗口（对话整段消失）。 */
    async createSlot(title, auto) {
      const current = this.currentSessionId()
      if (current === null) throw new Error('未找到当前会话')
      console.info('[gal-view:save] createSlot 开始:', title, 'auto=' + String(auto === true))
      const snapshot = typeof sessionsSvc.list?.getSnapshot === 'function' ? sessionsSvc.list.getSnapshot() : null
      const rootTitle = this.rootTitleOf(current, snapshot?.byId ?? {})
      const childId = await sessionsSvc.fork({ sessionId: current })
      console.info('[gal-view:save] fork 完成:', childId)
      try {
        const binding = sessionsSvc.binding?.(childId)
        const session = binding?.session ?? null
        if (session !== null && typeof session.rename === 'function') await session.rename(title)
      } catch {
        // 忽略：保留继承标题
      }
      // 槽位归档：不出现在工作区会话列表（官方归档语义，磁盘数据保留供读档 fork）。
      await this.archiveSessionQuiet(childId)
      const reg = this.readSlotsRegistry()
      const entry = { id: childId, title, updatedAt: Date.now() }
      if (auto) {
        // 自动存档仅保留最新一个：旧自动槽从名录移除（会话已归档，面板不再显示）。
        reg.autos = [entry]
      } else {
        reg.saves.push(entry)
      }
      if (rootTitle !== '') reg.rootTitle = rootTitle
      this.writeSlotsRegistry(reg)
      this.noteSaveOp()
      return { title, childId }
    },
    /** 手动存档改名：仅中文/英文/数字/部分符号；更新名录 + 尝试同步会话标题（归档槽可能失败，忽略）。 */
    async renameSlot(slotId, newTitle) {
      const value = String(newTitle ?? '').trim()
      if (!isValidSlotTitle(value)) throw new Error('名称仅支持中文、英文、数字与部分符号（- _ · … ！ ？ ! ? 。 .）')
      const reg = this.readSlotsRegistry()
      const target = reg.saves.find(s => s.id === slotId)
      if (target === undefined) throw new Error('存档不存在')
      target.title = value
      this.writeSlotsRegistry(reg)
      try {
        const binding = sessionsSvc?.binding?.(slotId)
        const session = binding?.session ?? null
        if (session !== null && typeof session.rename === 'function') await session.rename(value)
      } catch {
        // 忽略：归档槽无法改名时以名录为准
      }
      return { id: slotId, title: value }
    },
    /** 主线程标题：当前会话自身标题优先(用户改名立即生效,读档新线沿用新名),
     * 其次沿父链上溯,最后回退旧注册表。槽位名(xx-saveN/xx-自动N)一律不算主线程名。 */
    mainTitle() {
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      if (current !== null) {
        const byId = snapshot?.byId ?? {}
        const own = byId?.[current]?.title
        if (typeof own === 'string' && own !== '' && !isSlotTitle(own)) return own
        const chained = this.rootTitleOf(current, byId)
        if (chained !== '' && !isSlotTitle(chained)) return chained
      }
      const reg = this.readSlotsRegistry()
      if (reg.rootTitle !== '') return reg.rootTitle
      return ''
    },
    /** SAVE（手动）：创建快照槽 xx-saveN；不切换。 */
    async saveSlot() {
      if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
      const reg = this.readSlotsRegistry()
      const prefix = saveRootPrefix(this.mainTitle())
      const title = nextSaveTitle(prefix, reg.saves.map(s => s.n))
      return this.createSlot(title, false)
    },
    /** 自动存档（主线程，特殊标识「自动」，永不覆盖）：创建快照槽 xx-自动N；不切换。 */
    async autoSave() {
      if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
      const reg = this.readSlotsRegistry()
      const prefix = saveRootPrefix(this.mainTitle())
      const title = nextAutoTitle(prefix, reg.autos.map(s => s.n))
      return this.createSlot(title, true)
    },
    /** LOAD（读档）：从槽派生新世界线 → 切换 → 新线改回主线程原名 → 归档旧世界线。
     * 时序护栏：fork(槽) 不影响当前视图；open(子) 后轮询确认切换已落地
     * （list.current === childId）再归档旧线——官方在"当前会话被归档"时会
     * clear 当前选择，归档必须先确认切换完成。 */
    async loadSave(saveId) {
      if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
      const oldCurrent = this.currentSessionId()
      if (oldCurrent === null) throw new Error('未找到当前会话')
      const reg = this.readSlotsRegistry()
      const mainTitle = reg.rootTitle !== '' ? reg.rootTitle : this.rootTitleOf(oldCurrent, sessionsSvc?.list?.getSnapshot?.()?.byId ?? {})
      console.info('[gal-view:save] load: fork 槽', saveId)
      const childId = await sessionsSvc.fork({ sessionId: saveId })
      console.info('[gal-view:save] load: fork 完成', childId)
      await sessionsSvc.open(childId)
      const switched = await this.waitCurrentIs(childId, 2000)
      console.info('[gal-view:save] load: 切换' + (switched ? '已落地' : '未确认') + ', child=' + childId)
      // 新世界线沿用主线程原名（存档名只属于槽位）。
      if (mainTitle !== '') {
        try {
          const binding = sessionsSvc.binding?.(childId)
          const session = binding?.session ?? null
          if (session !== null && typeof session.rename === 'function') await session.rename(mainTitle)
        } catch {
          // 忽略：保留继承名
        }
      }
      // 销毁旧世界线：官方无删除接口，归档（列表消失、可恢复）。
      // 测试期开关(ARCHIVE_OLD_ON_LOAD=false)：确认 load/save 完全正确前不归档，
      // 旧线保留在工作区列表，可随时切回对比。
      if (ARCHIVE_OLD_ON_LOAD) {
        // 只有确认已切到新线才归档；未确认时放弃归档（旧线留在列表，绝不冒险）。
        if (this.currentSessionId() === oldCurrent) {
          console.warn('[gal-view:save] load: 当前会话仍未切换,放弃归档旧线(旧线保留在工作区):', oldCurrent)
        } else {
          await this.archiveSessionQuiet(oldCurrent)
        }
      } else {
        console.info('[gal-view:save] load: 测试期不归档旧线(旧线保留在工作区):', oldCurrent)
      }
      this.noteSaveOp()
      return { childId }
    },
    /** LOAD：切换到指定会话（读档）。 */
    async openSession(sessionId) {
      if (typeof sessionsSvc?.open !== 'function') throw new Error('当前环境不支持切换会话')
      await sessionsSvc.open(sessionId)
    },
    /** 会话列表订阅（存档面板自动刷新）；返回取消函数（服务缺失时返回 noop）。 */
    onSessions(cb) {
      const list = sessionsSvc?.list
      if (list === undefined || list === null || typeof list.subscribe !== 'function') return () => {}
      return list.subscribe(cb)
    },

    // ---- 文件式存档（SAVE 写文件零官方干预 / LOAD fork-atSeq 优先） ----

    /** 存档目录状态:{ supported, ready }。supported=浏览器支持 FS Access API。 */
    saveDirStatus() {
      return { supported: fsAccessSupported() }
    },
    /** 用户手势内调用:选一次工程文件夹(句柄持久化,之后静默)。返回是否成功。 */
    async ensureSaveDir() {
      if (!fsAccessSupported()) return false
      const dir = await resolveSaveDir()
      if (dir !== null) return true
      const picked = await pickDirectory()
      return picked !== null
    },
    /** 扫描目录列出文件槽位(读每个文件头解析元数据;损坏/非本插件文件跳过)。 */
    async listFileSlots() {
      const dir = await resolveSaveDir()
      const saves = []
      const autos = []
      const broken = []
      if (dir === null) return { ready: false, rootTitle: '', saves, autos, broken }
      const names = await withTimeout(listSaveFiles(dir), 8000, [])
      const mdNames = new Set()
      for (const name of names) {
        if (name.toLowerCase().endsWith('.zip')) continue
        const id = slotIdFromFileName(name)
        if (id === '') continue
        const text = await withTimeout(readSaveFile(dir, name), 5000, null)
        if (text === null) { broken.push(name); continue }
        const doc = parseSaveDoc(text)
        if (doc === null) { broken.push(name); continue }
        mdNames.add(name)
        const entry = {
          id,
          name,
          title: doc.meta.title,
          savedAt: doc.meta.savedAt,
          turns: doc.meta.turns,
          auto: doc.meta.auto,
        }
        if (doc.meta.auto) autos.push(entry)
        else saves.push(entry)
      }
      // 孤儿 zip:没有对应 md 的日志备份(如手工删了 md),提示可清理。
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.zip')) continue
        const id = slotIdFromFileName(name)
        if (id !== '' && !mdNames.has(id + '.md')) broken.push(name + '(孤立日志)')
      }
      saves.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN', { numeric: true }))
      autos.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN', { numeric: true }))
      const mainTitle = this.mainTitle()
      return { ready: true, rootTitle: mainTitle, saves, autos, broken }
    },
    /** 把采集好的记录写入存档文件(纯文件操作,不碰官方会话系统)。
     * payload: { auto, rootTitle, sessionId, atSeq, assistantName, turns, lines,
     *            complete, zip(Uint8Array|null), exportNote }
     * 写入顺序:先 zip(官方完整日志),再 md(可读记录+元数据);md 失败回滚 zip。
     * 自动档仅保留最新:新档全部成功后清理旧自动档的 md+zip。 */
    async saveSlotFile(payload) {
      if (payload.atSeq === null || payload.atSeq === undefined) throw new Error('还没有已完成的对话,先聊两句再存档吧')
      const dir = await resolveSaveDir()
      const existing = dir !== null ? await listSaveFiles(dir) : []
      const ids = existing.map(slotIdFromFileName).filter(id => id !== '')
      const prefix = fileSlotPrefix(payload.rootTitle)
      const id = nextFileSlotId(prefix, ids, payload.auto === true)
      const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : id
      const name = id + '.md'
      const zipName = id + '.zip'
      const hasZip = payload.zip !== null && payload.zip !== undefined && payload.zip !== ''
      const noteBase = typeof payload.exportNote === 'string' && payload.exportNote !== '' ? payload.exportNote + '。' : ''
      const note = noteBase + (noteBase === '' && !hasZip ? '官方日志导出不可用,完整记录以文本转录为准。' : '')
      const text = buildSaveDoc({ ...payload, title, note: note === '' ? undefined : note })
      if (dir === null) {
        if (fsAccessSupported()) {
          // 支持但未授权:首次存档需要用户授权一次(面板引导)。
          const error = new Error('首次存档需要授权文件夹(请点击「选择存档文件夹」)')
          error.code = 'dir-unauthorized'
          throw error
        }
        // 环境不支持:降级浏览器下载(Downloads)。
        let ok = true
        if (hasZip) ok = downloadBlobFile(zipName, payload.zip, 'application/zip') && ok
        ok = downloadTextFile(name, text) && ok
        if (!ok) throw new Error('下载存档失败(浏览器不支持文件写入)')
        return { id, name, title, fallback: true }
      }
      // ① 官方完整日志 zip(先写)
      if (hasZip) {
        await writeSaveZip(dir, zipName, payload.zip)
        console.info('[gal-view:save] 日志备份写入:', zipName)
      }
      // ② 可读记录 md;失败回滚 zip
      try {
        await writeSaveFile(dir, name, text)
      } catch (cause) {
        if (hasZip) { try { await removeSaveFile(dir, zipName) } catch { /* 忽略 */ } }
        throw cause
      }
      console.info('[gal-view:save] 存档文件写入:', name, '(atSeq=' + payload.atSeq + ', 完整日志=' + String(hasZip) + ')')
      // ③ 自动档清理(新档成功后)
      if (payload.auto === true) {
        for (const oldName of existing) {
          const slot = slotFromFileName(oldName, prefix)
          if (slot !== null && slot.auto && slot.id !== id) {
            await removeSaveFile(dir, oldName)
            await removeSaveFile(dir, slot.id + '.zip')
            console.info('[gal-view:save] 清理旧自动档文件:', oldName)
          }
        }
      }
      this.noteSaveOp()
      return { id, name, title, fallback: false }
    },
    /** 读文件存档:解析 → fork(当前主线, atSeq=存档点) → 打开新线。
     * 测试期不归档旧线(ARCHIVE_OLD_ON_LOAD=false)。
     * fork 不可用(主线不含该锚点/跨工程)时降级:新建会话 + 记录文本注入。 */
    async loadSaveFile(id) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const name = id.toLowerCase().endsWith('.md') ? id : id + '.md'
      const text = await readSaveFile(dir, name)
      if (text === null) throw new Error('存档文件已丢失(可能被移动或删除)')
      const doc = parseSaveDoc(text)
      if (doc === null) throw new Error('存档文件无法解析(格式损坏或不是本插件生成的存档)')
      // 迁移条目(旧式槽转来):读档走原会话槽 fork 路径——槽是独立分支,
      // fork-atSeq 无法精确锚定,绝不混用。
      if (doc.meta.legacySlotId !== null) {
        console.info('[gal-view:save] load-file: 迁移条目,走原会话槽读档:', doc.meta.legacySlotId)
        const legacyResult = await this.loadSave(doc.meta.legacySlotId)
        this.noteSaveOp()
        return { childId: legacyResult.childId, mode: 'legacy', lines: doc.lines, title: doc.meta.title }
      }
      const mainId = this.currentSessionId()
      if (mainId === null) throw new Error('未找到当前会话')
      const mainTitle = this.mainTitle()
      console.info('[gal-view:save] load-file: 解析成功', doc.meta.title, 'atSeq=' + String(doc.meta.atSeq), 'sessionId=' + doc.meta.sessionId)
      // 世界线校验:存档会话必须在当前主线的祖先链上(或就是主线),fork-atSeq
      // 才能精确切回存档点;否则官方会静默切到"最后一个完成回合",内容漂移。
      const snapForChain = sessionsSvc?.list?.getSnapshot?.() ?? null
      const byId = snapForChain !== null && typeof snapForChain === 'object' ? snapForChain.byId ?? {} : {}
      const anchored = doc.meta.sessionId === mainId || isAncestorOf(byId, doc.meta.sessionId, mainId)
      try {
        // 世界线校验:存档会话必须在当前主线的祖先链上(或就是主线),fork-atSeq
        // 才能精确切回存档点;否则官方会静默切到"最后一个完成回合",内容漂移,
        // 直接走内容级还原降级。
        if (!anchored) {
          console.warn('[gal-view:save] load-file: 存档会话不在当前主线祖先链上,跳过 fork-atSeq,降级为内容级还原:', doc.meta.sessionId, '→', mainId)
          throw new Error('worldline-detached')
        }
        if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
        if (doc.meta.atSeq === null) throw new Error('该存档没有存档点,无法按分叉还原')
        const childId = await sessionsSvc.fork({ sessionId: mainId, atSeq: doc.meta.atSeq })
        console.info('[gal-view:save] load-file: fork-atSeq 完成', childId)
        await sessionsSvc.open(childId)
        await this.waitCurrentIs(childId, 2000)
        if (mainTitle !== '' && mainTitle !== doc.meta.title) {
          try {
            const binding = sessionsSvc.binding?.(childId)
            const session = binding?.session ?? null
            if (session !== null && typeof session.rename === 'function') await session.rename(mainTitle)
          } catch {
            // 忽略:保留继承名
          }
        }
        if (ARCHIVE_OLD_ON_LOAD) {
          if (this.currentSessionId() === mainId) {
            console.warn('[gal-view:save] load-file: 当前会话仍未切换,放弃归档旧线:', mainId)
          } else {
            await this.archiveSessionQuiet(mainId)
          }
        } else {
          console.info('[gal-view:save] load-file: 测试期不归档旧线(旧线保留在工作区):', mainId)
        }
        this.noteSaveOp()
        return { childId, mode: 'fork', lines: doc.lines, title: doc.meta.title }
      } catch (cause) {
        console.warn('[gal-view:save] load-file: fork 还原失败,降级为内容级还原:', cause)
        if (!this.hasSessionsService() || typeof sessionsSvc.create !== 'function') throw cause
        const created = await sessionsSvc.create({})
        const createdId = typeof created === 'string' ? created : created?.sessionId ?? created?.value?.sessionId
        if (typeof createdId !== 'string' || createdId === '') throw cause
        await sessionsSvc.open(createdId)
        const recordText = linesToText(doc.lines, doc.meta.assistantName)
        this.noteSaveOp()
        return { childId: createdId, mode: 'inject', lines: doc.lines, title: doc.meta.title, recordText }
      }
    },
    /** 删除文件存档(直接删文件;不存在返回 false)。 */
    async deleteSlotFile(id) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const name = id.toLowerCase().endsWith('.md') ? id : id + '.md'
      const zipName = slotIdFromFileName(name) + '.zip'
      const removed = await withTimeout(removeSaveFile(dir, name), 5000, false)
      await withTimeout(removeSaveFile(dir, zipName), 5000, false)
      console.info('[gal-view:save] 删除存档文件:', name, '->', String(removed))
      return removed
    },
    /** 删除「无法识别」的杂项文件(面板列出的 broken 条目;兼容孤立 zip 后缀)。 */
    async deleteBrokenFile(name) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const clean = String(name).replace('(孤立日志)', '')
      if (clean === '') return false
      const removed = await withTimeout(removeSaveFile(dir, clean), 5000, false)
      if (clean.toLowerCase().endsWith('.md')) {
        await withTimeout(removeSaveFile(dir, clean.replace(/\.md$/i, '') + '.zip'), 5000, false)
      }
      console.info('[gal-view:save] 删除无法识别文件:', clean, '->', String(removed))
      return removed
    },
    /** 官方会话日志导出:GET /api/session.export → 完整日志 zip(Uint8Array)。
     * 纯后台流式下载,不碰会话窗口;失败抛错(调用方决定兜底)。 */
    async exportSessionLog(sessionId) {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求')
      const base = (typeof window !== 'undefined' && typeof window.location === 'object' && window.location !== null
        && typeof window.location.origin === 'string' && window.location.origin !== '' && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://dsh.internal'
      const url = new URL('/api/session.export', base)
      url.searchParams.set('sessionId', String(sessionId))
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = setTimeout(() => { controller?.abort() }, 60000)
      try {
        const response = await fetch(url.toString(), { method: 'GET', signal: controller?.signal ?? undefined })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const buffer = await response.arrayBuffer()
        return new Uint8Array(buffer)
      } finally {
        clearTimeout(timer)
      }
    },
    /** 官方 history RPC 逐页后台拉取 → 完整转写 { lines, turns, atSeq }。
     * 不装窗口、不增 DOM(区别于 loadOlder);服务缺失/失败返回 null。 */
    async captureTranscript(sessionId) {
      const wire = connectionSvc?.api
      if (wire === null || wire === undefined || typeof wire?.sessions?.history !== 'function') return null
      const events = []
      let beforeSeq
      try {
        for (let i = 0; i < 200; i++) {
          const response = await wire.sessions.history({
            sessionId,
            maxMessages: 50,
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          })
          const value = response?.result ?? response
          const page = Array.isArray(value?.events) ? value.events : []
          if (page.length === 0) break
          events.unshift(...page)
          if (value.hasMore !== true) break
          const first = page[0]?.event
          if (first === null || first === undefined || typeof first.seq !== 'number') break
          beforeSeq = first.seq
        }
      } catch (cause) {
        console.warn('[gal-view:save] captureTranscript 拉取失败:', cause)
        return null
      }
      return wireEventsToLines(events)
    },
    /** 存档互斥锁(全局:自动存档与手动存档共用)。 */
    tryLockSave() {
      if (saveLocked) return false
      saveLocked = true
      return true
    },
    unlockSave() {
      saveLocked = false
    },
    /**
     * 执行一次存档(全局统一入口,手动/自动共用):
     * ① 完整转写(history RPC;不可用时回退调用方提供的窗口行);
     * ② (手动档)后台导出官方完整日志 zip——**自动档跳过(skipZip)**:导出端点在
     *    主机侧触发会话日志持久化屏障(sessions.flush),自动档纯后台无法锁定用户输入,
     *    若新回合恰在此窗口开始会与活跃回合交互,曾引发官方窗口重装(对话消失);
     * ③ 一致性守卫(导出前 + 导出后各一次,guardCheck 返回会话 id/回合数);
     * ④ 写 zip+md(含自动档清理/回滚)。
     * @param opts.auto - 是否自动档
     * @param opts.skipZip - true 时不调用导出端点(自动档使用,记录=完整文本转写)
     * @param opts.guardCheck - async () => { sessionId, turns } 当前状态(守卫比对)
     * @param opts.fallbackLines - captureTranscript 不可用时回退的窗口采集(null 则失败)
     */
    async performFileSave(opts = {}) {
      if (!this.tryLockSave()) return { ok: false, reason: 'busy' }
      try {
        const sessionId = this.currentSessionId()
        if (sessionId === null) return { ok: false, reason: 'no-session' }
        const transcript = await this.captureTranscript(sessionId)
        let lines
        let turns
        let atSeq
        let captureNote = ''
        if (transcript !== null) {
          lines = transcript.lines
          turns = transcript.turns
          atSeq = transcript.atSeq
        } else if (opts.fallbackLines !== null && opts.fallbackLines !== undefined) {
          lines = opts.fallbackLines.lines
          turns = opts.fallbackLines.turns
          atSeq = opts.fallbackLines.atSeq
          captureNote = 'history 接口不可用,记录为窗口转写'
        } else {
          return { ok: false, reason: 'capture-unavailable' }
        }
        if (atSeq === null) return { ok: false, reason: 'empty' }
        const guardBefore = { sessionId, turns }
        const rootTitle = this.mainTitle()
        // 一致性守卫(导出前):若会话已变化,根本不去碰导出端点。
        const checkGuard = async () => {
          const now = await opts.guardCheck()
          return now !== null && now !== undefined && now.sessionId === guardBefore.sessionId && now.turns === guardBefore.turns
        }
        if (typeof opts.guardCheck === 'function' && !(await checkGuard())) {
          console.warn('[gal-view:save] 存档前会话已变化,中止:', guardBefore)
          return { ok: false, reason: 'interfered' }
        }
        let zip = null
        let exportNote = captureNote
        if (opts.skipZip !== true) {
          try {
            zip = await this.exportSessionLog(sessionId)
          } catch (cause) {
            console.warn('[gal-view:save] 官方日志导出失败:', cause)
            exportNote = (exportNote === '' ? '' : exportNote + ';') + '官方日志导出失败,记录为文本转录'
          }
        } else {
          exportNote = (exportNote === '' ? '' : exportNote + ';') + '自动档为完整文本记录(不含官方日志 zip)'
        }
        // 一致性守卫(导出后):存档期间对话有任何变化 → 中止,绝不产出不一致存档。
        if (typeof opts.guardCheck === 'function' && !(await checkGuard())) {
          console.warn('[gal-view:save] 存档期间对话发生变化,中止:', guardBefore)
          return { ok: false, reason: 'interfered' }
        }
        const result = await this.saveSlotFile({
          auto: opts.auto === true,
          rootTitle,
          sessionId,
          atSeq,
          assistantName: this.assistantName?.() ?? '',
          turns,
          lines,
          complete: true,
          zip,
          exportNote,
        })
        this.noteSaveOp()
        return { ok: true, ...result }
      } finally {
        this.unlockSave()
      }
    },
    /** 旧式槽迁移为新式文件存档(标题加"旧",md 正文用 history 转写;尽力导出 zip)。
     * onProgress(done, total) 汇报进度;完成后清空旧槽名录(面板"旧式存档"分区消失)。 */
    async migrateLegacySlots(onProgress) {
      const reg = this.readSlotsRegistry()
      const legacy = [...reg.saves, ...reg.autos]
      if (legacy.length === 0) return { migrated: 0 }
      const dir = await resolveSaveDir()
      if (dir === null) {
        const error = new Error('首次使用需要授权存档文件夹')
        error.code = 'dir-unauthorized'
        throw error
      }
      let done = 0
      for (const slot of legacy) {
        const id = '旧' + slot.id
        const name = id + '.md'
        const zipName = id + '.zip'
        const existingMd = await readSaveFile(dir, name)
        if (existingMd === null) {
          const transcript = await this.captureTranscript(slot.id)
          const lines = transcript !== null ? transcript.lines : []
          const turns = transcript !== null ? transcript.turns : 0
          let zip = null
          try { zip = await this.exportSessionLog(slot.id) } catch { /* 归档槽导出失败可接受 */ }
          const text = buildSaveDoc({
            title: '旧' + slot.title,
            savedAt: typeof slot.updatedAt === 'number' ? slot.updatedAt : Date.now(),
            rootTitle: reg.rootTitle,
            sessionId: slot.id,
            atSeq: null,
            assistantName: '',
            turns,
            auto: false,
            legacySlotId: slot.id,
            lines,
            note: '由旧式会话槽迁移;读档走原会话槽路径;完整内容见同名 zip',
          })
          if (zip !== null) await writeSaveZip(dir, zipName, zip)
          try {
            await writeSaveFile(dir, name, text)
          } catch (cause) {
            if (zip !== null) { try { await removeSaveFile(dir, zipName) } catch { /* 忽略 */ } }
            throw cause
          }
          console.info('[gal-view:save] 旧档迁移:', name)
        }
        done += 1
        if (typeof onProgress === 'function') onProgress(done, legacy.length)
      }
      reg.saves = []
      reg.autos = []
      this.writeSlotsRegistry(reg)
      return { migrated: done }
    },
    /** 当前工程路径(会话 cwd;缺失返回空串)。 */
    projectPath() {
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      if (current === null) return ''
      const cwd = snapshot?.byId?.[current]?.cwd
      return typeof cwd === 'string' ? cwd : ''
    },
    /** 存档目录信息:{ supported, authorized, dirName, projectPath, mismatch }。
     * dirName=已授权工程文件夹名;mismatch=授权目录与当前工程路径不一致。 */
    async saveDirInfo() {
      const supported = fsAccessSupported()
      let dirName = ''
      let authorized = false
      if (supported) {
        const handle = await loadDirHandle()
        if (handle !== null && handle !== undefined) {
          authorized = true
          dirName = typeof handle.name === 'string' ? handle.name : ''
        }
      }
      const projectPath = this.projectPath()
      const pathBase = String(projectPath).split(/[\\/]/).filter(Boolean).pop() ?? ''
      const mismatch = authorized && dirName !== '' && pathBase !== '' && dirName !== pathBase
      return { supported, authorized, dirName, projectPath, mismatch }
    },
    /** 当前 AI 名牌(存档记录用)。 */
    assistantName() {
      return assistantDisplayName(sceneSource.getSnapshot())
    },
  }
}

/** 槽位注册表键（localStorage）。 */
const SLOTS_KEY = 'gal-view:slots'

/**
 * 读档后是否归档旧世界线。测试期关闭(用户要求):确认 load/save 完全正确后再改 true。
 * 关闭时旧线保留在工作区列表,可随时切回对比,不影响新世界线继续。
 */
const ARCHIVE_OLD_ON_LOAD = false

/** 标题是否像槽位名（xx-saveN / xx-自动N）——主线程标题不应取槽位名。 */
function isSlotTitle(title) {
  return /-save\d+$/.test(title) || /-自动\d+$/.test(title)
}

/** 从会话列表快照取当前会话 id（兼容 { current } / { currentId } 字段名）。 */
function sessionOf(snapshot) {
  if (snapshot === null || snapshot === undefined) return null
  if (typeof snapshot.current === 'string' && snapshot.current !== '') return snapshot.current
  if (typeof snapshot.currentId === 'string' && snapshot.currentId !== '') return snapshot.currentId
  return null
}

/**
 * 客户端插件入口：注入样式、构建场景运行时、注册视图标签页。
 * @param ctx - client 根上下文（提供 slots 服务）。
 */
export function apply(ctx) {
  // 幂等守卫：重复执行（HMR/loader 重跑）不重复注入样式。
  if (document.querySelector('style[data-gal-view-style]') !== null) return

  const styleEl = document.createElement('style')
  styleEl.setAttribute('data-gal-view-style', '')
  styleEl.setAttribute('data-plugin', 'gal-view')
  styleEl.textContent = CSS
  document.head.append(styleEl)

  // 分叉存档依赖客户端 sessions 服务（官方「分叉会话」同一通道）；缺失时功能降级。
  // 必须在 createSceneApi 之前读取（方法体闭包引用该绑定）。
  const sessionsSvc = ctx.get('sessions')
  // archiveSession 在 workspaces 服务上（sessions 服务没有）；两者皆可缺省（功能降级）。
  const workspacesSvc = ctx.get('workspaces')
  // 官方连接服务：history RPC(captureTranscript 完整转写)经它调用；缺失时降级。
  const connectionSvc = ctx.get('connection')

  const storage = createStorage()
  // 素材库：IndexedDB 持久 + 内存可观察镜像（图片 dataURL 不进 localStorage）。
  const assetsSource = createObservable({ map: new Map() })
  const idb = createIdbAssets()
  void idb.getAll().then(records => {
    // 合并而非替换：预设种子素材（同步种入内存镜像）可能尚未落库，替换会丢。
    if (records.length > 0) {
      const map = new Map(assetsSource.getSnapshot().map)
      for (const record of records) map.set(record.id, record)
      assetsSource.update({ map })
    }
  }).catch(() => {})
  // 字体库：IndexedDB 持久 + @font-face 动态注册。
  const fontsSource = createObservable({ map: new Map() })
  const fontIdb = createIdbFonts()
  const fontStyleEl = document.createElement('style')
  fontStyleEl.setAttribute('data-gal-view-fonts', '')
  fontStyleEl.setAttribute('data-plugin', 'gal-view')
  document.head.append(fontStyleEl)
  const syncFontStyles = () => {
    const faces = [...fontsSource.getSnapshot().map.values()].map(buildFontFace)
    fontStyleEl.textContent = faces.join('\n')
  }
  syncFontStyles()
  fontsSource.subscribe(syncFontStyles)
  void fontIdb.getAll().then(records => {
    // 合并而非替换：预设种子字体（同步种入内存镜像）可能尚未落库，替换会丢。
    if (records.length > 0) {
      const map = new Map(fontsSource.getSnapshot().map)
      for (const record of records) map.set(record.id, record)
      fontsSource.update({ map })
      syncFontStyles()
    }
  }).catch(() => {})

  // 默认预设：仓库根 gal-scene.json（导出格式，内嵌被引用素材/字体）。
  // 首次启动（本地无存档场景）加载预设场景，并把内嵌素材/字体还原进库；
  // 已有存档场景的用户不受影响（编辑模式「重置」也回到预设）。
  const hasPreset = presetScene !== null && typeof presetScene === 'object'
  const seedPresetAssets = () => {
    if (!hasPreset) return
    const embedded = extractAssets(presetScene)
    if (embedded.length > 0) {
      const map = new Map(assetsSource.getSnapshot().map)
      for (const record of embedded) {
        map.set(record.id, record)
        void idb.put(record).catch(() => {})
      }
      assetsSource.update({ map })
    }
    const embeddedFonts = extractFonts(presetScene)
    if (embeddedFonts.length > 0) {
      const map = new Map(fontsSource.getSnapshot().map)
      for (const record of embeddedFonts) {
        map.set(record.id, record)
        void fontIdb.put(record).catch(() => {})
      }
      fontsSource.update({ map })
    }
  }
  const presetBase = () => (hasPreset ? (normalizeScene(presetScene) ?? defaultScene()) : defaultScene())
  const savedScene = loadJSON(storage, PERSIST_KEY)
  const usePreset = hasPreset && savedScene === null
  // 迁移：旧场景补「台词」、双名牌与六个预设功能按钮（幂等）；铺满型背景归一；
  // 旧自动补位的保存/读取按钮归位到标准底排（旧浏览器本地场景自愈）。
  const initial = ensureSaveButtonLayout(ensureBackgroundCover(ensureActionButtons(ensureSpeakerNames(ensureDialogueText(
    (usePreset ? presetBase() : normalizeScene(savedScene)) ?? defaultScene(),
  )))))
  if (usePreset) seedPresetAssets()
  const sceneSource = createObservable(initial)
  const history = createHistory(HISTORY_LIMIT)
  const historySource = createObservable({ undo: 0, redo: 0 })
  const api = createSceneApi(sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase, sessionsSvc, workspacesSvc, connectionSvc)

  // ---- 全局自动存档控制器(apply 级,不依赖 GAL 视图挂载)----
  // 在其他窗口/皮肤下同样运行;状态发布到 autoSaveSource 供设置面板显示。
  // 初始化隔离:控制器异常绝不影响插件其余部分(视图注册/存档面板等)。
  const autoSaveSource = createObservable({ lastAt: null, lastResult: null, lastReason: '', turns: 0, baseline: 0, every: 10 })
  let disposeAutoSave = () => {}
  try {
    disposeAutoSave = createGlobalAutoSave({ sessionsSvc, api, sceneSource, statusSource: autoSaveSource })
  } catch (cause) {
    console.warn('[gal-view] 自动存档控制器初始化失败(自动存档不可用,其余功能不受影响):', cause)
  }
  ctx.effect(() => disposeAutoSave, 'gal-view: global autosave')

  // ---- 存档操作看门狗(仅记录,不干预)----
  // 官方在「当前会话被归档」时会 clear 当前选择(对话栏整个空白)。此处只记录
  // 该事件发生的时间与最后已知会话,不自动 open——自动干预会与官方合法的
  // 清空(用户点新会话等)打架,且曾与官方状态机产生耦合(8-26 事故后确立:
  // 看门狗只记录、不动手;要恢复干预,先拿 [gal-view:watchdog] 日志证明残余竞态)。
  let lastMainId = null
  let lastOpAt = 0
  api._noteSaveOp = () => {
    lastOpAt = Date.now()
    const cur = api.currentSessionId()
    if (cur !== null) lastMainId = cur
  }
  const offSelectionWatch = typeof sessionsSvc?.list?.subscribe === 'function'
    ? sessionsSvc.list.subscribe(() => {
        try {
          const cur = api.currentSessionId()
          if (cur !== null) {
            lastMainId = cur
            return
          }
          if (lastMainId !== null && Date.now() - lastOpAt < 8000) {
            console.warn('[gal-view:watchdog] 检测到存档操作后当前选择被清空(最近会话: ' + lastMainId + ',8s 内)。日志仅供诊断,不自动恢复;如对话消失请 F5 刷新。')
          }
        } catch {
          // 忽略
        }
      })
    : null
  if (offSelectionWatch !== null) ctx.effect(() => offSelectionWatch, 'gal-view: selection watchdog')

  // 官方「对话」栏输入框默认语句：与 GAL 视窗一致「你想和AI名牌说什么呢？」
  // 官方 UI 会随渲染重写 placeholder，观察器在每次改写后补回（scene 名牌变化也同步）。
  const syncOfficialPlaceholder = () => {
    const name = assistantDisplayName(sceneSource.getSnapshot())
    const text = '你想和' + name + '说什么呢？'
    for (const input of document.querySelectorAll('textarea[data-phase]')) {
      if (input.getAttribute('placeholder') !== text) input.setAttribute('placeholder', text)
    }
  }
  syncOfficialPlaceholder()
  const placeholderObserver = new MutationObserver((records) => {
    const touched = records.some(record => record.type === 'childList')
      || records.some(record => record.type === 'attributes' && record.attributeName === 'placeholder')
    if (touched) syncOfficialPlaceholder()
  })
  placeholderObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder'] })
  const offScenePlaceholder = sceneSource.subscribe(syncOfficialPlaceholder)
  ctx.effect(() => () => { placeholderObserver.disconnect(); offScenePlaceholder() }, 'gal-view: official placeholder')

  // 插件开关：设置选项卡控制会话页「GAL视窗」标签的显隐。
  const enabledSource = createObservable(loadJSON(storage, ENABLED_KEY) !== false)
  const setEnabled = value => {
    enabledSource.update(value === true)
    saveJSON(storage, ENABLED_KEY, value === true)
  }

  ctx.effect(() => () => { styleEl.remove(); fontStyleEl.remove() }, 'gal-view: styles')

  // 注册 conversation.view 列表条目：order 5 落在「对话」(0) 与「轨迹」(10) 之间。
  // slots.inject 等待槽位声明，声明崩溃时随纤维一起移除标签页。
  // 响应开关：禁用时注销条目（标签页消失），启用时重新注册。
  ctx.slots.inject('conversation.view', () => {
    let dispose = null
    const sync = () => {
      if (dispose !== null) {
        dispose()
        dispose = null
      }
      if (enabledSource.getSnapshot() !== true) return
      dispose = ctx.slots.register({
        name: 'conversation.view',
        id: 'gal',
        order: 5,
        label: () => 'GAL视窗',
        store: createReadStore(),
        inject: () => ({
          hooks: { scene: sceneSource, history: historySource, assets: assetsSource, fonts: fontsSource, autoSaveStatus: autoSaveSource },
          api,
        }),
      }, GalView)
    }
    sync()
    const unsubscribe = enabledSource.subscribe(sync)
    return () => {
      unsubscribe()
      if (dispose !== null) dispose()
    }
  })

  // 设置面板「插件」分区下的 GAL 视窗选项卡（启用/停用开关）。
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'gal-view',
    order: 20,
    label: () => 'GAL 视窗',
    inject: () => ({
      hooks: { enabled: enabledSource },
      setEnabled,
    }),
  }, GalViewSettingsTab))
}
