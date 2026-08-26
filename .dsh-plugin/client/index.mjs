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
 * archiveSession 在它上面(不在 sessions 上)。缺失时存档相关方法降级。 */
function createSceneApi(sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase, sessionsSvc, workspacesSvc) {
  const current = () => sceneSource.getSnapshot()

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
        const chained = this.rootTitleOf(current, byId)
        if (chained !== '' && !isSlotTitle(chained)) rootTitle = chained
      }
      return { rootId: current, rootTitle, saves: reg.saves, autos: reg.autos }
    },
    /** 归档一个会话（archiveSession 在 workspaces 服务上；sessions 服务没有）。 */
    async archiveSessionQuiet(sessionId) {
      const op = workspacesSvc?.archiveSession ?? sessionsSvc?.archiveSession
      if (typeof op === 'function') {
        try {
          await op.call(workspacesSvc?.archiveSession !== undefined ? workspacesSvc : sessionsSvc, sessionId)
        } catch {
          // 归档失败不阻断：旧会话残留可在官方列表手动归档
        }
      }
    },
    /** 快照式创建：fork 当前会话 + 命名 + 归档 + 入名录。 */
    async createSlot(title, auto) {
      const current = this.currentSessionId()
      if (current === null) throw new Error('未找到当前会话')
      const snapshot = typeof sessionsSvc.list?.getSnapshot === 'function' ? sessionsSvc.list.getSnapshot() : null
      const rootTitle = this.rootTitleOf(current, snapshot?.byId ?? {})
      const childId = await sessionsSvc.fork({ sessionId: current })
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
    /** 主线程标题：注册表优先，缺失时沿当前会话父链解析（链缺失回退当前会话标题）。 */
    mainTitle() {
      const reg = this.readSlotsRegistry()
      if (reg.rootTitle !== '') return reg.rootTitle
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      if (current === null) return ''
      return this.rootTitleOf(current, snapshot?.byId ?? {})
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
    /** LOAD（读档）：从槽派生新世界线 → 切换 → 新线改回主线程原名 → 归档旧世界线。 */
    async loadSave(saveId) {
      if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
      const oldCurrent = this.currentSessionId()
      if (oldCurrent === null) throw new Error('未找到当前会话')
      const reg = this.readSlotsRegistry()
      const mainTitle = reg.rootTitle !== '' ? reg.rootTitle : this.rootTitleOf(oldCurrent, sessionsSvc?.list?.getSnapshot?.()?.byId ?? {})
      const childId = await sessionsSvc.fork({ sessionId: saveId })
      await sessionsSvc.open(childId)
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
      await this.archiveSessionQuiet(oldCurrent)
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
  }
}

/** 槽位注册表键（localStorage）。 */
const SLOTS_KEY = 'gal-view:slots'

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
  const api = createSceneApi(sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase, sessionsSvc, workspacesSvc)

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
          hooks: { scene: sceneSource, history: historySource, assets: assetsSource, fonts: fontsSource },
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
