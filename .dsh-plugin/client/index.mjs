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
  defaultScene, normalizeScene, ensureDialogueText, ensureSpeakerNames, ensureActionButtons,
  ensureBackgroundCover, ensureSaveButtonLayout,
} from './scene.mjs'
import {
  embedAssets, extractAssets, createIdbAssets,
} from './assets.mjs'
import {
  buildFontFace, extractFonts, createIdbFonts,
} from './fonts.mjs'
import { createObservable, createHistory, createStorage, loadJSON, saveJSON } from './store.mjs'
import { saveRootPrefix, rootOf, nextSaveTitle, nextAutoTitle, isValidSlotTitle } from './save.mjs'
import { waitSettled } from './settle.mjs'
import { fileSlotPrefix } from './savefile.mjs'
import {
  lazyService, sessionOf, titleFromProjection, waitSettledSnapshotOf,
  applyComposerPlaceholder,
} from './host-adapter.mjs'
import { createSceneEditingApi, PERSIST_KEY } from './api-scene.mjs'
import { createFileSaveApi } from './api-file-save.mjs'
import { createGlobalAutoSave } from './autosave.mjs'
import { assistantDisplayName } from './transcript.mjs'
// 默认预设场景：仓库根 gal-scene.json（编辑器导出的格式，内嵌被引用的素材/字体）。
import presetScene from '../../gal-scene.json'

export const name = 'gal-view'

/** 依赖服务：槽位系统（会话数据经槽位框架注入，无需直接消费 sessions）。 */
export const inject = ['slots']

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
  /** 当前会话 id(上游 v0.1.2 起 sessions 服务无 list 快照):GalView 挂载时经
   * setViewSessionId 注入;旧运行时 list 路径保留兜底。 */
  let viewSessionId = null

  return {
    // 场景编辑(场景/元素/素材/字体/撤销重做)——领域拆分至 api-scene.mjs。
    ...createSceneEditingApi({ sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase }),

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
    /** 视图注入当前会话 id(上游 v0.1.2:sessions 服务无 list 快照)。 */
    setViewSessionId(id) {
      if (typeof id === 'string' && id !== '') viewSessionId = id
    },
    currentSessionId() {
      if (typeof viewSessionId === 'string' && viewSessionId !== '') return viewSessionId
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
    /** 面板数据：注册表名录 + 主线程标题（以注册表为准，父链解析兜底）。
     * 需求:旧式槽(会话分叉槽)跨工程共享注册表,面板只显示当前工程前缀匹配的槽。 */
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
      // 当前主标题优先于注册表(投影/list 双源后的 mainTitle)。
      const live = this.mainTitle()
      if (live !== '') rootTitle = live
      const prefix = fileSlotPrefix(rootTitle)
      const inProject = slot => prefix === '' || String(slot.title ?? '').startsWith(prefix)
      return { rootId: current, rootTitle, saves: reg.saves.filter(inProject), autos: reg.autos.filter(inProject) }
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
    /** 落定闸门：等 running=false 且连续 quietMs 无变化。
     * 返回 { settled, completed, aborted }；服务缺失时 settled=false。
     * 上游 v0.1.2:list 快照没了 → 用绑定会话的 SessionSnapshot(running/blank 仍在),
     * 合成旧式 { current, byId } 形状喂给纯逻辑 waitSettled;list 路径保留兜底。 */
    async waitSettled(opts = {}) {
      const list = sessionsSvc?.list
      if (list !== null && list !== undefined && typeof list.getSnapshot === 'function') {
        return waitSettled({
          getSnapshot: () => list.getSnapshot(),
          subscribe: typeof list.subscribe === 'function' ? cb => list.subscribe(cb) : null,
          quietMs: typeof opts.quietMs === 'number' ? opts.quietMs : 2500,
          timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000,
          shouldContinue: typeof opts.shouldContinue === 'function' ? opts.shouldContinue : undefined,
        })
      }
      // 新面:绑定会话快照合成旧式列表形状(契约见 host-adapter.waitSettledSnapshotOf)。
      const id = this.currentSessionId()
      const binding = id !== null ? sessionsSvc?.binding?.(id) : null
      const session = binding?.session ?? null
      if (session !== null && typeof session.getSnapshot === 'function') {
        return waitSettled({
          getSnapshot: () => waitSettledSnapshotOf(id, session.getSnapshot()),
          subscribe: typeof session.subscribe === 'function' ? cb => session.subscribe(cb) : null,
          quietMs: typeof opts.quietMs === 'number' ? opts.quietMs : 2500,
          timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000,
          shouldContinue: typeof opts.shouldContinue === 'function' ? opts.shouldContinue : undefined,
        })
      }
      return { settled: false, completed: false, aborted: false }
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
    /** 记录一次存档操作（看门狗据此判断"官方清空当前选择"是否是我们引发的）。 */
    noteSaveOp() {
      this._noteSaveOp?.()
    },
    /** 快照式创建：fork 当前会话 + 命名 + 归档 + 入名录。
     * 调用方必须先过落定闸门（waitSettled）——对未落定的活跃会话 fork 会
     * 打断官方会话窗口（对话整段消失）。 */
    async createSlot(title, auto) {
      const current = this.currentSessionId()
      if (current === null) return { ok: false, reason: '未找到当前会话', code: 'no-session' }
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
      return { ok: true, value: { title, childId } }
    },
    /** 手动存档改名：仅中文/英文/数字/部分符号；更新名录 + 尝试同步会话标题（归档槽可能失败，忽略）。 */
    async renameSlot(slotId, newTitle) {
      const value = String(newTitle ?? '').trim()
      if (!isValidSlotTitle(value)) return { ok: false, reason: '名称仅支持中文、英文、数字与部分符号（- _ · … ！ ？ ! ? 。 .）' }
      const reg = this.readSlotsRegistry()
      const target = reg.saves.find(s => s.id === slotId)
      if (target === undefined) return { ok: false, reason: '存档不存在' }
      target.title = value
      this.writeSlotsRegistry(reg)
      try {
        const binding = sessionsSvc?.binding?.(slotId)
        const session = binding?.session ?? null
        if (session !== null && typeof session.rename === 'function') await session.rename(value)
      } catch {
        // 忽略：归档槽无法改名时以名录为准
      }
      return { ok: true, value: { id: slotId, title: value } }
    },
    /** 主线程标题：当前会话自身标题优先(用户改名立即生效,读档新线沿用新名),
     * 其次沿父链上溯,最后回退旧注册表。槽位名(xx-saveN/xx-自动N)一律不算主线程名。
     * 上游 v0.1.2:list 快照没了 → 首选 title 投影(binding.session.projections)。 */
    mainTitle() {
      const id = this.currentSessionId()
      if (id !== null) {
        try {
          const projections = sessionsSvc?.binding?.(id)?.session?.projections
          const titleSnap = typeof projections?.faceOf === 'function' ? projections.faceOf('title')?.getSnapshot?.() : null
          const projected = titleFromProjection(titleSnap)
          if (projected !== '' && !isSlotTitle(projected) && !/^s-created-\d+$/.test(projected)) return projected
        } catch {
          // 投影缺失:走旧路径
        }
      }
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      if (current !== null) {
        const byId = snapshot?.byId ?? {}
        const own = byId?.[current]?.title
        // 注入回退创建的新会话标题是生成名(s-created-N),不算主线程名。
        if (typeof own === 'string' && own !== '' && !isSlotTitle(own) && !/^s-created-\d+$/.test(own)) return own
        const chained = this.rootTitleOf(current, byId)
        if (chained !== '' && !isSlotTitle(chained)) return chained
      }
      const reg = this.readSlotsRegistry()
      if (reg.rootTitle !== '') return reg.rootTitle
      return ''
    },
    /** SAVE（手动）：创建快照槽 xx-saveN；不切换。 */
    async saveSlot() {
      if (!this.hasSessionsService()) return { ok: false, reason: '当前环境不支持会话分叉' }
      const reg = this.readSlotsRegistry()
      const prefix = saveRootPrefix(this.mainTitle())
      const title = nextSaveTitle(prefix, reg.saves.map(s => s.n))
      const result = await this.createSlot(title, false)
      return result.ok ? { ok: true, value: result.value } : result
    },
    /** 自动存档（主线程，特殊标识「自动」，永不覆盖）：创建快照槽 xx-自动N；不切换。 */
    async autoSave() {
      if (!this.hasSessionsService()) return { ok: false, reason: '当前环境不支持会话分叉' }
      const reg = this.readSlotsRegistry()
      const prefix = saveRootPrefix(this.mainTitle())
      const title = nextAutoTitle(prefix, reg.autos.map(s => s.n))
      const result = await this.createSlot(title, true)
      return result.ok ? { ok: true, value: result.value } : result
    },
    /** LOAD（读档）：从槽派生新世界线 → 切换 → 新线改回主线程原名 → 归档旧世界线。
     * 时序护栏：fork(槽) 不影响当前视图；open(子) 后轮询确认切换已落地
     * （list.current === childId）再归档旧线——官方在"当前会话被归档"时会
     * clear 当前选择，归档必须先确认切换完成。 */
    async loadSave(saveId) {
      if (!this.hasSessionsService()) return { ok: false, reason: '当前环境不支持会话分叉' }
      const oldCurrent = this.currentSessionId()
      if (oldCurrent === null) return { ok: false, reason: '未找到当前会话', code: 'no-session' }
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
      // 由设置项「读档后归档旧对话」控制(默认关):关时旧线保留在工作区列表,可随时切回对比。
      if (sceneSource.getSnapshot().settings.archiveOldOnLoad === true) {
        // 只有确认已切到新线才归档；未确认时放弃归档（旧线留在列表，绝不冒险）。
        if (this.currentSessionId() === oldCurrent) {
          console.warn('[gal-view:save] load: 当前会话仍未切换,放弃归档旧线(旧线保留在工作区):', oldCurrent)
        } else {
          await this.archiveSessionQuiet(oldCurrent)
        }
      } else {
        console.info('[gal-view:save] load: 设置未开启归档,旧线保留在工作区:', oldCurrent)
      }
      this.noteSaveOp()
      void this.checkConversationIntegrity()
      return { ok: true, value: { childId } }
    },
    /** LOAD：切换到指定会话（读档）。 */
    async openSession(sessionId) {
      if (typeof sessionsSvc?.open !== 'function') return { ok: false, reason: '当前环境不支持切换会话' }
      await sessionsSvc.open(sessionId)
      return { ok: true }
    },
    /** 会话列表订阅（存档面板自动刷新）；返回取消函数（服务缺失时返回 noop）。 */
    onSessions(cb) {
      const list = sessionsSvc?.list
      if (list === undefined || list === null || typeof list.subscribe !== 'function') return () => {}
      return list.subscribe(cb)
    },

    // 存档引擎(文件式存档/读档/迁移/转写/完整性检查)——领域拆分至 api-file-save.mjs。
    ...createFileSaveApi({ sceneSource, sessionsSvc, workspacesSvc, connectionSvc }),
  }
}

/** 槽位注册表键（localStorage）。 */
const SLOTS_KEY = 'gal-view:slots'

/** 标题是否像槽位名（xx-saveN / xx-自动N）——主线程标题不应取槽位名。 */
function isSlotTitle(title) {
  return /-save\d+$/.test(title) || /-自动\d+$/.test(title)
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
  // 宿主适配层(A1):服务一律经 lazyService 惰性解析(启动顺序无关),契约见 host-adapter.mjs。
  const sessionsSvc = lazyService(ctx, 'sessions')
  // archiveSession 在 workspaces 服务上（sessions 服务没有）；两者皆可缺省（功能降级）。
  const workspacesSvc = lazyService(ctx, 'workspaces')
  // 官方连接服务：history RPC(captureTranscript 完整转写)经它调用；缺失时降级。
  const connectionSvc = lazyService(ctx, 'connection')

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
  // 宿主适配层(A1):新壳 contentEditable + 旧壳 textarea 双适配,选择器契约见 host-adapter。
  const syncOfficialPlaceholder = () => {
    const name = assistantDisplayName(sceneSource.getSnapshot())
    applyComposerPlaceholder('你想和' + name + '说什么呢？')
  }
  syncOfficialPlaceholder()
  const placeholderObserver = new MutationObserver((records) => {
    const touched = records.some(record => record.type === 'childList')
      || records.some(record => record.type === 'attributes' && record.attributeName === 'placeholder')
      || records.some(record => record.type === 'attributes' && record.attributeName === 'data-placeholder')
    if (touched) syncOfficialPlaceholder()
  })
  placeholderObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder', 'data-placeholder'] })
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
