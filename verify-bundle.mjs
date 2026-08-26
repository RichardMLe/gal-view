// 仿真验证：加载 gal-view bundle → apply() → 模拟 slots 注册拿到 api → 端到端测分叉存档路径。
import { readFileSync } from 'node:fs'

const code = readFileSync('.dsh-plugin/client.js', 'utf8')

const store = new Map()
const localStorageMock = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: k => { store.delete(k) },
}
const styleElMock = () => ({ tagName: 'STYLE', setAttribute() {}, textContent: '', remove() {} })
globalThis.window = { localStorage: localStorageMock, __ModuleLoader__: null }
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], createElement: () => styleElMock(), head: { append() {} }, body: {} }
globalThis.indexedDB = undefined
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const reactStub = new Proxy(function () {}, {
  get: (t, p) => (p === Symbol.iterator || p === '__esModule' ? undefined : reactStub),
  apply: () => reactStub,
})
const requireStub = name => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
}

let captured = null
window.__ModuleLoader__ = { load: ({ id, factory }) => { captured = factory(requireStub) } }
new Function('window', 'document', code)(window, document)

// —— sessions mock（形状对齐 dsh-client-runtime；无 archiveSession——它在 workspaces 上）——
let renameCalls = []
let forkSeq = 0
let listCurrent = 's-root'
let openSwitches = true
const sessionsMock = {
  list: {
    getSnapshot: () => ({
      current: listCurrent,
      byId: {
        's-root': { sessionId: 's-root', title: '深海脑探案', parentSessionId: undefined, updatedAt: 1700000000000, running: false, completed: true },
        's-save1': { sessionId: 's-save1', title: '深海脑-save1', parentSessionId: 's-root', updatedAt: 1700000100000, running: false, completed: true },
        's-auto1': { sessionId: 's-auto1', title: '深海脑-自动1', parentSessionId: 's-root', updatedAt: 1700000300000, running: false, completed: true },
      },
    }),
    subscribe: () => () => {},
  },
  fork: () => { forkSeq += 1; return Promise.resolve('s-new-' + forkSeq) },
  // 真实运行时 open(select) 同步切换 list.current;openSwitches=false 模拟切换未落地的竞态。
  open: id => { openCalls.push(id); if (openSwitches) listCurrent = id; return Promise.resolve() },
  binding: id => ({
    session: {
      rename: title => { renameCalls.push([id, title]); return Promise.resolve({ ok: true }) },
    },
  }),
}
const workspacesMock = {
  archiveSession: id => { archiveCalls.push(id); return Promise.resolve({ ok: true }) },
}
let openCalls = []
let archiveCalls = []

// —— slots mock：真正执行 inject 回调并捕获 register 载荷 ——
let registeredApi = null
const ctxMock = {
  get: name => (name === 'sessions' ? sessionsMock : name === 'workspaces' ? workspacesMock : undefined),
  effect: () => {},
  slots: {
    inject: (name, fn) => {
      // 立即执行“声明已就绪”逻辑（模拟 slots 服务在声明后触发）
      fn()
    },
    register: (options) => {
      const payload = options.inject()
      if (options.name === 'conversation.view') registeredApi = payload.api
      return () => {}
    },
  },
}

try {
  captured.apply(ctxMock)
} catch (error) {
  console.error('FAIL apply:', error)
  process.exit(1)
}
if (registeredApi === null) {
  console.error('FAIL: ai api not captured')
  process.exit(1)
}
console.log('apply ok; api captured:', typeof registeredApi.saveIndex)

// —— 端到端 ——
try {
  const empty = registeredApi.saveIndex()
  if (empty.saves.length !== 0 || empty.autos.length !== 0) { console.error('FAIL fresh registry should be empty'); process.exit(1) }
  console.log('fresh registry ok:', JSON.stringify(empty))

  await registeredApi.saveSlot()
  console.log('renameCalls:', JSON.stringify(renameCalls))
  if (renameCalls[0]?.[1] !== '深海脑-save1') { console.error('FAIL saveSlot title'); process.exit(1) }
  // 槽位应立即归档（不出现在工作区列表）
  if (archiveCalls[0] !== 's-new-1') { console.error('FAIL slot not archived'); process.exit(1) }

  await registeredApi.autoSave()
  if (renameCalls[1]?.[1] !== '深海脑-自动1') { console.error('FAIL autoSave title: ' + renameCalls[1]?.[1]); process.exit(1) }
  console.log('autoSave ok:', renameCalls[1][1])

  const index = registeredApi.saveIndex()
  console.log('saveIndex:', JSON.stringify({ rootTitle: index.rootTitle, saves: index.saves.map(s => s.title), autos: index.autos.map(s => s.title) }))
  if (index.saves.length !== 1 || index.saves[0].title !== '深海脑-save1') { console.error('FAIL registry saves'); process.exit(1) }
  if (index.autos.length !== 1 || index.autos[0].title !== '深海脑-自动1') { console.error('FAIL registry autos'); process.exit(1) }
  if (index.rootTitle !== '深海脑探案') { console.error('FAIL rootTitle'); process.exit(1) }

  await registeredApi.loadSave(index.saves[0].id)
  console.log('loadSave openCalls:', JSON.stringify(openCalls), 'archiveCalls:', JSON.stringify(archiveCalls), 'renameCalls:', JSON.stringify(renameCalls))
  if (openCalls[0] !== 's-new-3') { console.error('FAIL loadSave fork child not opened: ' + openCalls[0]); process.exit(1) }
  // 新世界线改回主线程原名
  if (renameCalls[2]?.[0] !== 's-new-3' || renameCalls[2]?.[1] !== '深海脑探案') { console.error('FAIL loadSave rename to main title'); process.exit(1) }
  // 旧世界线归档（切换已确认后）
  if (!archiveCalls.includes('s-root')) { console.error('FAIL loadSave old line not archived'); process.exit(1) }

  // —— 竞态护栏：open 未切换落地的读档必须放弃归档旧线（官方会因归档当前会话清空对话）——
  openSwitches = false
  const archivedBefore = archiveCalls.length
  await registeredApi.loadSave(index.saves[0].id)
  console.log('loadSave(no-switch) openCalls:', JSON.stringify(openCalls), 'archiveCalls:', JSON.stringify(archiveCalls))
  if (archiveCalls.length !== archivedBefore) { console.error('FAIL guard: archived while current did not switch'); process.exit(1) }
  openSwitches = true

  if (registeredApi.hasSessionsService() !== true) { console.error('FAIL hasSessionsService'); process.exit(1) }
  console.log('ALL OK')
} catch (error) {
  console.error('FAIL e2e:', error)
  process.exit(1)
}
