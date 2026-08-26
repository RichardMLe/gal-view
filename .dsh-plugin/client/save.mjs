// 分叉存档纯逻辑:命名计算 + 分支树展开。零宿主依赖,可单测。
// 命名:xx-saveN —— xx = 根祖先(主线程)标题前 3 字(空标题回退 GAL),
// N = 该根系下最末存档序号 + 1(存档位置)。存档条目只认标题匹配 ^xx-save\d+$。

/** 标题清洗:压缩空白。 */
function clipTitle(title, cap) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, cap)
}

/** 主线程前缀:根标题前 3 字;空回退 'GAL'。 */
export function saveRootPrefix(rootTitle) {
  const t = clipTitle(rootTitle, 3)
  return t === '' ? 'GAL' : t
}

/** 正则转义。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 存档标题匹配器:^xx-save(\d+)$。 */
export function saveTitleMatcher(prefix) {
  return new RegExp('^' + escapeRegExp(String(prefix)) + '-save(\\d+)$')
}

/** 自动存档标题匹配器:^xx-自动(\d+)$（特殊标识「自动」，与手动存档区分）。 */
export function autoTitleMatcher(prefix) {
  return new RegExp('^' + escapeRegExp(String(prefix)) + '-自动(\\d+)$')
}

/** 统一摘要读取:{ id, title, parentId, updatedAt }(宿主字段名差异兜底)。 */
export function summaryOf(entry, fallbackId) {
  const id = String(entry?.sessionId ?? fallbackId ?? '')
  const parentValue = entry?.parentId ?? entry?.parentSessionId
  return {
    id,
    title: typeof entry?.title === 'string' ? entry.title : '',
    parentId: typeof parentValue === 'string' && parentValue !== '' ? parentValue : null,
    updatedAt: typeof entry?.updatedAt === 'number'
      ? entry.updatedAt
      : (typeof entry?.createdAt === 'number' ? entry.createdAt : 0),
  }
}

/** 沿 parent 链上溯到根;父缺失(不在表内)即视为当前节点为根。 */
export function rootOf(byId, id, guard = 64) {
  let cur = String(id ?? '')
  let depth = 0
  while (cur !== '' && depth < guard) {
    const entry = byId[cur]
    if (entry === undefined || entry === null) break
    const parent = summaryOf(entry, cur).parentId
    if (parent === null || byId[parent] === undefined) return cur
    cur = parent
    depth += 1
  }
  return String(id ?? '')
}

/** 指定根的全部后代 id(递归,含隔代;子表按 parent 聚合)。 */
export function descendantsOf(byId, rootId) {
  const children = new Map()
  for (const key of Object.keys(byId)) {
    const entry = byId[key]
    if (entry === undefined || entry === null) continue
    const parent = summaryOf(entry, key).parentId
    if (parent !== null && byId[parent] !== undefined) {
      const list = children.get(parent) ?? []
      list.push(key)
      children.set(parent, list)
    }
  }
  const out = []
  const walk = id => {
    for (const child of children.get(id) ?? []) {
      out.push(child)
      walk(child)
    }
  }
  walk(String(rootId))
  return out
}

/** 该根系下全部 xx-saveN 存档:[{ id, title, n, updatedAt }],按 n 升序。 */
export function collectSaves(byId, rootId, prefix) {
  const matcher = saveTitleMatcher(prefix)
  const saves = []
  for (const id of descendantsOf(byId, rootId)) {
    const entry = byId[id]
    if (entry === undefined || entry === null) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    const m = matcher.exec(title)
    if (m === null) continue
    saves.push({ id, title, n: parseInt(m[1], 10), updatedAt: summaryOf(entry, id).updatedAt })
  }
  saves.sort((a, b) => a.n - b.n)
  return saves
}

/** 下一个存档标题:prefix-save(maxN+1)。 */
export function nextSaveTitle(prefix, existingNs) {
  let max = 0
  for (const n of existingNs) {
    if (typeof n === 'number' && Number.isFinite(n) && n > max) max = n
  }
  return String(prefix) + '-save' + (max + 1)
}

/** 下一个自动存档标题:prefix-自动(maxN+1)（特殊标识；仅保留最新一个）。 */
export function nextAutoTitle(prefix, existingNs) {
  let max = 0
  for (const n of existingNs) {
    if (typeof n === 'number' && Number.isFinite(n) && n > max) max = n
  }
  return String(prefix) + '-自动' + (max + 1)
}

/** 手动存档改名校验：仅允许中文、英文、数字、空格与部分符号（- _ · … ！ ？ ! ? 。 .），
 * 拒绝其余特殊字符；空串拒绝。 */
const SLOT_TITLE_OK = /^[\u4e00-\u9fa5A-Za-z0-9 _\-·…！？!?。.]+$/
export function isValidSlotTitle(text) {
  const value = String(text ?? '').trim()
  if (value === '' || value.length > 40) return false
  return SLOT_TITLE_OK.test(value)
}

/**
 * 槽位全景：手动存档（xx-saveN）+ 自动存档（xx-自动N），各按 N 升序；
 * 当前会话（currentId）从两组中剔除——存档槽自身永不参与游戏，不会被读档"弄脏"。
 */
export function collectSlots(byId, rootId, prefix, currentId) {
  const saveMatcher = saveTitleMatcher(prefix)
  const autoMatcher = autoTitleMatcher(prefix)
  const saves = []
  const autos = []
  for (const id of descendantsOf(byId, rootId)) {
    const entry = byId[id]
    if (entry === undefined || entry === null || id === currentId) continue
    const title = typeof entry.title === 'string' ? entry.title : ''
    const updatedAt = summaryOf(entry, id).updatedAt
    const mSave = saveMatcher.exec(title)
    if (mSave !== null) { saves.push({ id, title, n: parseInt(mSave[1], 10), updatedAt }); continue }
    const mAuto = autoMatcher.exec(title)
    if (mAuto !== null) autos.push({ id, title, n: parseInt(mAuto[1], 10), updatedAt })
  }
  saves.sort((a, b) => a.n - b.n)
  autos.sort((a, b) => a.n - b.n)
  return { saves, autos }
}
