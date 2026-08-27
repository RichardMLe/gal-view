// 仿真验证：加载 gal-view bundle → apply() → 模拟 slots 注册拿到 api →
// 端到端测旧式分叉存档 + 新文件式存档(fork-atSeq 读档/不归档/删除/降级注入)。
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
// —— 假 IndexedDB:只存目录句柄(loadDirHandle/storeDirHandle 用)——
const handleStore = new Map()
globalThis.indexedDB = {
  open: () => {
    const req = {}
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction: () => {
          const tx = {}
          // 写事务提交后回调 oncomplete(storeDirHandle 等待它再关库)
          setTimeout(() => { if (typeof tx.oncomplete === 'function') tx.oncomplete() }, 0)
          tx.objectStore = () => ({
            get: key => { const r = {}; setTimeout(() => { r.result = handleStore.get(key) ?? null; if (typeof r.onsuccess === 'function') r.onsuccess() }, 0); return r },
            put: (value, key) => { handleStore.set(key, value) },
          })
          return tx
        },
        close() {},
      }
      if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded()
      if (typeof req.onsuccess === 'function') req.onsuccess()
    }, 0)
    return req
  },
}
// —— 假文件系统(FS Access API 目录)——
const fakeFiles = new Map()
const fakeDir = {
  kind: 'directory',
  entries: () => (function* () { for (const [name, handle] of fakeFiles) yield [name, handle] })(),
  getDirectoryHandle: () => Promise.resolve(fakeDir),
  getFileHandle: name => Promise.resolve({
    kind: 'file',
    createWritable: () => Promise.resolve({
      write: text => { fakeFiles.set(name, { kind: 'file', content: String(text) }) },
      close: () => Promise.resolve(),
    }),
    getFile: () => Promise.resolve({ text: () => Promise.resolve(fakeFiles.get(name)?.content ?? null) }),
  }),
  removeEntry: name => { fakeFiles.delete(name); return Promise.resolve() },
  queryPermission: () => Promise.resolve('granted'),
  requestPermission: () => Promise.resolve('granted'),
}
globalThis.window.isSecureContext = true
globalThis.window.showDirectoryPicker = async () => { handleStore.set('dir', fakeDir); return fakeDir }
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
let forkCalls = []
let forkSeq = 0
let createSeq = 0
let forkReject = false
let listCurrent = 's-root'
let openSwitches = true
const listById = {
  's-root': { sessionId: 's-root', title: '深海脑探案', parentSessionId: undefined, updatedAt: 1700000000000, running: false, completed: true },
  's-save1': { sessionId: 's-save1', title: '深海脑-save1', parentSessionId: 's-root', updatedAt: 1700000100000, running: false, completed: true },
  's-auto1': { sessionId: 's-auto1', title: '深海脑-自动1', parentSessionId: 's-root', updatedAt: 1700000300000, running: false, completed: true },
}
const sessionsMock = {
  list: {
    getSnapshot: () => ({ current: listCurrent, byId: listById }),
    subscribe: () => () => {},
  },
  fork: (opts) => {
    forkCalls.push({ ...opts })
    forkSeq += 1
    const id = 's-new-' + forkSeq
    listById[id] = { sessionId: id, title: id, parentSessionId: opts.sessionId, updatedAt: Date.now(), running: false, completed: true }
    if (forkReject) return Promise.reject(new Error('fork-unavailable: no completed turn'))
    return Promise.resolve(id)
  },
  create: () => {
    createSeq += 1
    const id = 's-created-' + createSeq
    listById[id] = { sessionId: id, title: id, updatedAt: Date.now(), running: false, completed: true, blank: true }
    return Promise.resolve(id)
  },
  // 真实运行时 open(select) 同步切换 list.current;openSwitches=false 模拟切换未落地的竞态。
  open: id => { openCalls.push(id); if (openSwitches) listCurrent = id; return Promise.resolve() },
  binding: id => ({
    session: {
      rename: title => { renameCalls.push([id, title]); return Promise.resolve({ ok: true }) },
      // 窗口事件数组(完整性检查用):s-root 的窗口尾部 seq 可注入,模拟被截断。
      events: id === 's-root' ? [{ seq: windowTailSeq, type: 'turn/end', time: 0, data: {} }] : [],
      resync: () => { resyncCalls.push(id); return Promise.resolve() },
    },
  }),
}
const workspacesMock = {
  archiveSession: id => { archiveCalls.push(id); return Promise.resolve({ ok: true }) },
}
let openCalls = []
let archiveCalls = []
let resyncCalls = []
let windowTailSeq = 60

// —— 官方 history RPC 假数据(s-root:15 轮完整事件,共 60 条,分页拉取)——
const fakeWireEvents = []
let wireSeq = 0
for (let t = 1; t <= 15; t++) {
  fakeWireEvents.push({ type: 'turn/start', seq: ++wireSeq, time: 1700000000000 + wireSeq, data: { turn: t } })
  fakeWireEvents.push({ type: 'user/message', surfaceOp: 'append', seq: ++wireSeq, time: 1700000000000 + wireSeq, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第' + t + '问' }] } })
  fakeWireEvents.push({ type: 'assistant/message', surfaceOp: 'append', seq: ++wireSeq, time: 1700000000000 + wireSeq, data: { blocks: [{ kind: 'text', text: '第' + t + '答' }] } })
  fakeWireEvents.push({ type: 'turn/end', seq: ++wireSeq, time: 1700000000000 + wireSeq, data: { turn: t } })
}
const historyMock = ({ sessionId, beforeSeq, maxMessages }) => {
  const all = sessionId === 's-root' ? fakeWireEvents : []
  let page
  if (beforeSeq === undefined) {
    page = all.slice(-maxMessages)
  } else {
    const idx = all.findIndex(e => e.seq === beforeSeq)
    page = idx > 0 ? all.slice(Math.max(0, idx - maxMessages), idx) : []
  }
  const hasMore = all.length > 0 && page.length > 0 && all[0].seq < page[0].seq
  // 与官方 web-runtime 实测契约一致:{ result: { ok, value: { events, hasMore, projections } } }
  return Promise.resolve({ result: { ok: true, value: { events: page.map(event => ({ event, view: null })), hasMore, projections: undefined } } })
}
const connectionMock = { api: { sessions: { history: historyMock } } }

// —— slots mock：真正执行 inject 回调并捕获 register 载荷 ——
let registeredApi = null
const ctxMock = {
  get: name => (name === 'sessions' ? sessionsMock : name === 'workspaces' ? workspacesMock : name === 'connection' ? connectionMock : undefined),
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
  // 测试期开关:读档后不归档旧线(用户要求)
  if (archiveCalls.includes('s-root')) { console.error('FAIL loadSave archived old line while testing flag is off'); process.exit(1) }

  // —— 竞态护栏(开关打开时的行为,直接校验归档守卫逻辑不因开关关闭而回归)——
  openSwitches = false
  const archivedBefore = archiveCalls.length
  await registeredApi.loadSave(index.saves[0].id)
  console.log('loadSave(no-switch) openCalls:', JSON.stringify(openCalls), 'archiveCalls:', JSON.stringify(archiveCalls))
  if (archiveCalls.length !== archivedBefore) { console.error('FAIL guard: archived while current did not switch'); process.exit(1) }
  openSwitches = true

  // —— 文件式存档 e2e ——
  console.log('--- 文件式存档 ---')
  const dirOk = await registeredApi.ensureSaveDir()
  if (dirOk !== true) { console.error('FAIL ensureSaveDir'); process.exit(1) }
  const prep = await registeredApi.prepareSaveDir()
  if (prep.status !== 'ready' || prep.dir === null) { console.error('FAIL prepareSaveDir: ' + JSON.stringify(prep)); process.exit(1) }
  console.log('prepareSaveDir ok:', prep.status)
  listCurrent = 's-root'
  const saved = await registeredApi.saveSlotFile({
    auto: false, rootTitle: '深海脑探案', sessionId: 's-root', atSeq: 42,
    assistantName: '雾子', turns: 7,
    lines: [{ kind: 'player', text: '你好' }, { kind: 'assistant', text: '你好呀\n第二行' }],
  })
  if (saved.id !== '深海脑-save1' || saved.title !== '深海脑-save1') { console.error('FAIL saveSlotFile id/title: ' + JSON.stringify(saved)); process.exit(1) }
  if (!fakeFiles.has('深海脑-save1.md')) { console.error('FAIL saveSlotFile file not written'); process.exit(1) }
  console.log('saveSlotFile ok:', saved.id)

  const fileList = await registeredApi.listFileSlots()
  console.log('listFileSlots:', JSON.stringify(fileList))
  if (fileList.ready !== true || fileList.saves.length !== 1 || fileList.saves[0].title !== '深海脑-save1' || fileList.saves[0].turns !== 7) { console.error('FAIL listFileSlots'); process.exit(1) }

  // 自动档:两次存档,第二次清理第一次(仅保留最新)
  const auto1 = await registeredApi.saveSlotFile({ auto: true, rootTitle: '深海脑探案', sessionId: 's-root', atSeq: 42, assistantName: '雾子', turns: 1, lines: [{ kind: 'player', text: 'a' }] })
  const auto2 = await registeredApi.saveSlotFile({ auto: true, rootTitle: '深海脑探案', sessionId: 's-root', atSeq: 42, assistantName: '雾子', turns: 1, lines: [{ kind: 'player', text: 'b' }] })
  if (auto1.id !== '深海脑-自动1' || auto2.id !== '深海脑-自动2') { console.error('FAIL auto naming: ' + auto1.id + '/' + auto2.id); process.exit(1) }
  if (fakeFiles.has('深海脑-自动1.md')) { console.error('FAIL old auto file not cleaned'); process.exit(1) }
  const autoList = await registeredApi.listFileSlots()
  if (autoList.autos.length !== 1 || autoList.autos[0].id !== '深海脑-自动2') { console.error('FAIL auto list: ' + JSON.stringify(autoList.autos)); process.exit(1) }
  console.log('auto file ok:', autoList.autos.map(s => s.id).join(','))

  const beforeLoadArchive = archiveCalls.length
  const forkCallsBefore = forkCalls.length
  const loaded = await registeredApi.loadSaveFile('深海脑-save1')
  console.log('loadSaveFile forkCalls:', JSON.stringify(forkCalls.slice(forkCallsBefore)), 'mode:', loaded.mode)
  if (forkCalls[forkCallsBefore]?.atSeq !== 42 || forkCalls[forkCallsBefore]?.sessionId !== 's-root') { console.error('FAIL loadSaveFile fork payload: ' + JSON.stringify(forkCalls[forkCallsBefore])); process.exit(1) }
  if (loaded.mode !== 'fork' || loaded.childId !== 's-new-' + (forkSeq)) { console.error('FAIL loadSaveFile fork result: ' + JSON.stringify(loaded)); process.exit(1) }
  // 测试期:旧线不归档
  if (archiveCalls.length !== beforeLoadArchive) { console.error('FAIL loadSaveFile archived while testing'); process.exit(1) }

  // —— 降级注入:fork 失败 → create+open+记录文本 ——
  forkReject = true
  const injected = await registeredApi.loadSaveFile('深海脑-save1')
  forkReject = false
  console.log('loadSaveFile(inject) mode:', injected.mode, 'childId:', injected.childId)
  if (injected.mode !== 'inject' || injected.childId !== 's-created-1') { console.error('FAIL inject fallback: ' + JSON.stringify(injected)); process.exit(1) }
  if (typeof injected.recordText !== 'string' || !injected.recordText.includes('你好呀')) { console.error('FAIL inject recordText'); process.exit(1) }
  if (!openCalls.includes('s-created-1')) { console.error('FAIL inject open'); process.exit(1) }

  // —— 删除文件存档 ——
  const removed = await registeredApi.deleteSlotFile('深海脑-save1')
  if (removed !== true || fakeFiles.has('深海脑-save1.md')) { console.error('FAIL deleteSlotFile'); process.exit(1) }
  const afterDelete = await registeredApi.listFileSlots()
  if (afterDelete.saves.length !== 0) { console.error('FAIL list after delete'); process.exit(1) }
  console.log('deleteSlotFile ok')

  // —— 世界线脱钩:存档会话不在当前主线祖先链上 → 绝不 fork,降级注入 ——
  const detached = await registeredApi.saveSlotFile({ auto: false, rootTitle: '深海脑探案', sessionId: 's-other', atSeq: 99, assistantName: '雾子', turns: 1, lines: [{ kind: 'player', text: '另一条线' }] })
  const forkBeforeDetached = forkCalls.length
  const detachedLoaded = await registeredApi.loadSaveFile(detached.id)
  console.log('loadSaveFile(detached) mode:', detachedLoaded.mode)
  if (detachedLoaded.mode !== 'inject') { console.error('FAIL worldline-detached should inject: ' + JSON.stringify(detachedLoaded)); process.exit(1) }
  if (forkCalls.length !== forkBeforeDetached) { console.error('FAIL worldline-detached must not fork'); process.exit(1) }
  await registeredApi.deleteSlotFile(detached.id)
  console.log('worldline-detached ok')

  // —— zip 双文件:带官方日志 zip 的存档 → md+zip 成对写入;删除成对删除 ——
  const withZip = await registeredApi.saveSlotFile({
    auto: false, rootTitle: '深海脑探案', sessionId: 's-root', atSeq: 42, assistantName: '雾子', turns: 2,
    lines: [{ kind: 'player', text: 'z' }], complete: true, zip: new Uint8Array([1, 2, 3]), exportNote: '',
  })
  if (withZip.id !== '深海脑-save1') { console.error('FAIL zip save id: ' + JSON.stringify(withZip)); process.exit(1) }
  if (!fakeFiles.has('深海脑-save1.md') || !fakeFiles.has('深海脑-save1.zip')) { console.error('FAIL zip+md pair not written'); process.exit(1) }
  const withZipList = await registeredApi.listFileSlots()
  if (withZipList.broken.some(b => String(b).includes('深海脑-save1.zip'))) { console.error('FAIL paired zip flagged broken: ' + JSON.stringify(withZipList.broken)); process.exit(1) }
  const withZipRemoved = await registeredApi.deleteSlotFile(withZip.id)
  if (!withZipRemoved || fakeFiles.has('深海脑-save1.md') || fakeFiles.has('深海脑-save1.zip')) { console.error('FAIL zip pair delete'); process.exit(1) }
  console.log('zip pair ok')

  // —— 孤儿 zip:只有 zip 没有 md → 计入无法识别 ——
  fakeFiles.set('深海脑-save99.zip', { kind: 'file', content: 'PK' })
  const orphanList = await registeredApi.listFileSlots()
  if (!orphanList.broken.some(b => String(b).includes('深海脑-save99.zip'))) { console.error('FAIL orphan zip not flagged: ' + JSON.stringify(orphanList.broken)); process.exit(1) }
  fakeFiles.delete('深海脑-save99.zip')
  console.log('orphan zip ok')

  // —— 导出接口:无 fetch 环境应明确报错(调用方走兜底) ——
  let exportThrew = false
  try { await registeredApi.exportSessionLog('s-root') } catch { exportThrew = true }
  if (!exportThrew) { console.error('FAIL exportSessionLog should throw without fetch'); process.exit(1) }
  console.log('exportSessionLog fallback ok')

  // —— performFileSave:P2 真实总回合数(15,来自 history 转写)+ atSeq=history 尾部 seq ——
  listCurrent = 's-root'
  const pfs = await registeredApi.performFileSave({ auto: false, guardCheck: async () => ({ sessionId: 's-root', turns: 15 }) })
  if (!pfs.ok) { console.error('FAIL performFileSave: ' + JSON.stringify(pfs)); process.exit(1) }
  const pfsText = String(fakeFiles.get('深海脑-save1.md')?.content ?? '')
  if (!pfsText.includes('第1问') || !pfsText.includes('第15答')) { console.error('FAIL performFileSave record incomplete'); process.exit(1) }
  const pfsList = await registeredApi.listFileSlots()
  const pfsEntry = pfsList.saves.find(s => s.id === '深海脑-save1')
  if (pfsEntry === undefined || pfsEntry.turns !== 15) { console.error('FAIL performFileSave turns (P2): ' + JSON.stringify(pfsEntry)); process.exit(1) }
  const forkBeforePfs = forkCalls.length
  await registeredApi.loadSaveFile('深海脑-save1')
  if (forkCalls[forkBeforePfs]?.atSeq !== 60) { console.error('FAIL load atSeq from history: ' + JSON.stringify(forkCalls[forkBeforePfs])); process.exit(1) }
  console.log('performFileSave ok (turns=' + pfsEntry.turns + ', atSeq=60)')

  // —— skipZip(自动档):不调用导出端点(零 flush),仅完整文本 md ——
  listCurrent = 's-root'
  const pfsAuto = await registeredApi.performFileSave({ auto: true, skipZip: true, guardCheck: async () => ({ sessionId: 's-root', turns: 15 }) })
  if (!pfsAuto.ok) { console.error('FAIL performFileSave skipZip: ' + JSON.stringify(pfsAuto)); process.exit(1) }
  const pfsAutoText = String(fakeFiles.get(pfsAuto.id + '.md')?.content ?? '')
  if (!pfsAutoText.includes('自动档为完整文本记录')) { console.error('FAIL skipZip note missing'); process.exit(1) }
  if (!pfsAutoText.includes('第15答')) { console.error('FAIL skipZip record incomplete'); process.exit(1) }
  if (fakeFiles.has(pfsAuto.id + '.zip')) { console.error('FAIL skipZip must not write zip'); process.exit(1) }
  console.log('skipZip ok:', pfsAuto.id)

  // —— 对话栏完整性检查:窗口尾部落后持久日志 >8 → 自动 resync 恢复 ——
  listCurrent = 's-root'
  windowTailSeq = 60
  const intactBefore = resyncCalls.length
  const intactResult = await registeredApi.checkConversationIntegrity()
  if (intactResult !== false || resyncCalls.length !== intactBefore) { console.error('FAIL integrity: healthy window should not resync'); process.exit(1) }
  windowTailSeq = 20
  const brokenResult = await registeredApi.checkConversationIntegrity()
  if (brokenResult !== true || !resyncCalls.includes('s-root')) { console.error('FAIL integrity: truncated window should resync'); process.exit(1) }
  windowTailSeq = 60
  console.log('conversation integrity check ok')

  // —— 旧式槽迁移(P4):按钮触发 → 进度 → 完成后旧槽名录清空、迁移条目并入列表 ——
  const progress = []
  const mig = await registeredApi.migrateLegacySlots((done, total) => progress.push([done, total]))
  if (mig.migrated !== 2) { console.error('FAIL migrate count: ' + JSON.stringify(mig)); process.exit(1) }
  if (progress[progress.length - 1]?.[0] !== 2 || progress[progress.length - 1]?.[1] !== 2) { console.error('FAIL migrate progress: ' + JSON.stringify(progress)); process.exit(1) }
  if (!fakeFiles.has('旧s-new-1.md') || !fakeFiles.has('旧s-new-2.md')) { console.error('FAIL migrate files not written'); process.exit(1) }
  const afterMig = registeredApi.saveIndex()
  if (afterMig.saves.length !== 0 || afterMig.autos.length !== 0) { console.error('FAIL registry not cleared after migrate'); process.exit(1) }
  const listAfterMig = await registeredApi.listFileSlots()
  const migratedEntry = listAfterMig.saves.find(s => s.id === '旧s-new-1')
  if (migratedEntry === undefined || migratedEntry.title !== '旧深海脑-save1') { console.error('FAIL migrated entry: ' + JSON.stringify(listAfterMig.saves.map(s => [s.id, s.title]))); process.exit(1) }
  // 迁移条目读档:走原会话槽 fork 路径,不是 fork-atSeq 当前主线
  listCurrent = 's-root'
  const forkBeforeLegacyLoad = forkCalls.length
  const legLoad = await registeredApi.loadSaveFile('旧s-new-1')
  if (legLoad.mode !== 'legacy') { console.error('FAIL legacy routing mode: ' + JSON.stringify(legLoad)); process.exit(1) }
  const legacyFork = forkCalls[forkCalls.length - 1]
  if (legacyFork?.sessionId !== 's-new-1' || legacyFork.atSeq !== undefined) { console.error('FAIL legacy fork payload: ' + JSON.stringify(legacyFork)); process.exit(1) }
  if (forkCalls.length !== forkBeforeLegacyLoad + 1) { console.error('FAIL legacy load should fork exactly once'); process.exit(1) }
  console.log('migrate ok')

  // —— 改名修复(方案 C):当前会话自身标题优先 ——
  const renameSave = await registeredApi.saveSlotFile({
    auto: false, rootTitle: '深海脑探案', sessionId: 's-root', atSeq: 42, assistantName: '雾子', turns: 2,
    lines: [{ kind: 'player', text: '改名前存档' }], complete: true,
  })
  listCurrent = 's-root'
  listById['s-root'].title = '新名字探案'
  if (registeredApi.mainTitle() !== '新名字探案') { console.error('FAIL mainTitle own-title: ' + registeredApi.mainTitle()); process.exit(1) }
  const renamedLoad = await registeredApi.loadSaveFile(renameSave.id)
  const lastRename = renameCalls[renameCalls.length - 1]
  if (renamedLoad.mode !== 'fork' || lastRename?.[1] !== '新名字探案') { console.error('FAIL load rename to new title: ' + JSON.stringify(lastRename)); process.exit(1) }
  console.log('rename fix ok')

  if (registeredApi.hasSessionsService() !== true) { console.error('FAIL hasSessionsService'); process.exit(1) }
  console.log('ALL OK')
} catch (error) {
  console.error('FAIL e2e:', error)
  process.exit(1)
}
