// 文件式存档的纯逻辑:存档文件格式(自描述 markdown)的序列化/解析、
// 槽位命名与目录扫描对账。零宿主依赖,可单测。
//
// 文件格式(schema 1):
//   首行:<!-- gal-view-save v1 <JSON> -->(单行,HTML 注释,markdown 渲染不可见)
//   其余:人类可读的 markdown 记录(【玩家】/【AI】/【系统】分节,思考/对话分开)。
// 文件即真相源:标题/时间/存档点 seq 都在头里,复制文件到别的工程也能读取记录正文。

import { saveRootPrefix } from './save.mjs'

/** 角色标记:build 时写入,parse 时识别。 */
const ROLE_MARK = {
  player: '【玩家】',
  assistant: '【AI】',
  system: '【系统】',
}

/** 从标记行还原角色。 */
function roleOfMark(line) {
  if (line.startsWith(ROLE_MARK.player)) return 'player'
  if (line.startsWith(ROLE_MARK.assistant)) return 'assistant'
  if (line.startsWith(ROLE_MARK.system)) return 'system'
  return null
}

/** 行角色 → 标记。 */
function markOfRole(role) {
  return ROLE_MARK[role] ?? ROLE_MARK.system
}

/** 把多行台词编码成单行(段落分隔符在文本内部保留,换行折叠)。 */
function encodeLine(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n+/g, ' ⏎ ').trim()
}

/** 还原编码行。 */
function decodeLine(text) {
  return String(text ?? '').split(' ⏎ ').filter(part => part !== '').join('\n')
}

/** 时间戳 → 本地可读串(无效返回空)。 */
function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 构建存档文档。
 * @param doc { title, savedAt, rootTitle, sessionId, atSeq, assistantName, turns, auto, lines }
 *   lines: [{ kind: 'player'|'assistant'|'system', text }]
 * @returns 完整文件文本(UTF-8)。
 */
export function buildSaveDoc(doc) {
  const meta = {
    schema: 1,
    title: String(doc.title ?? ''),
    savedAt: Number.isFinite(doc.savedAt) ? doc.savedAt : Date.now(),
    rootTitle: String(doc.rootTitle ?? ''),
    sessionId: String(doc.sessionId ?? ''),
    atSeq: Number.isFinite(doc.atSeq) ? Math.floor(doc.atSeq) : null,
    assistantName: String(doc.assistantName ?? ''),
    turns: Number.isFinite(doc.turns) ? Math.floor(doc.turns) : 0,
    auto: doc.auto === true,
  }
  const header = '<!-- gal-view-save v1 ' + JSON.stringify(meta) + ' -->'
  const lines = Array.isArray(doc.lines) ? doc.lines : []
  const body = []
  body.push('# ' + meta.title)
  const savedAtText = formatTime(meta.savedAt)
  body.push('')
  body.push('> 存档时间:' + (savedAtText === '' ? '未知' : savedAtText)
    + ' · 主线程:' + (meta.rootTitle === '' ? '未知' : meta.rootTitle)
    + ' · 回合数:' + meta.turns
    + ' · 类型:' + (meta.auto ? '自动存档' : '手动存档'))
  body.push('')
  body.push('## 对话记录')
  body.push('')
  for (const line of lines) {
    if (line === null || typeof line !== 'object') continue
    const role = line.kind === 'player' || line.kind === 'assistant' ? line.kind : 'system'
    body.push(markOfRole(role) + encodeLine(line.text))
  }
  body.push('')
  body.push('---')
  body.push('')
  body.push('> 本文件由 GAL 视窗自动生成。读档优先走官方会话分叉(按存档点 seq 还原多轮气泡);')
  body.push('> 此文件同时是可见的记录副本,可备份/复制/删除。')
  body.push('')
  return header + '\n' + body.join('\n')
}

/**
 * 解析存档文档(宽容:格式不对返回 null,不抛错)。
 * @returns { meta, lines } 或 null。
 */
export function parseSaveDoc(text) {
  if (typeof text !== 'string' || text === '') return null
  const firstLine = text.slice(0, 4096).split('\n', 1)[0] ?? ''
  const m = /^<!--\s*gal-view-save\s+v1\s+(\{.*\})\s*-->$/.exec(firstLine.trim())
  if (m === null) return null
  let meta
  try {
    meta = JSON.parse(m[1])
  } catch {
    return null
  }
  if (meta === null || typeof meta !== 'object' || meta.schema !== 1) return null
  if (typeof meta.title !== 'string' || typeof meta.sessionId !== 'string') return null
  const lines = []
  const body = text.split('\n').slice(1)
  let current = null
  for (const raw of body) {
    const role = roleOfMark(raw)
    if (role !== null) {
      const mark = markOfRole(role)
      current = { kind: role, text: decodeLine(raw.slice(mark.length)) }
      lines.push(current)
    } else if (current !== null && raw.trim() !== '' && !raw.startsWith('#') && !raw.startsWith('-') && !raw.startsWith('>')) {
      // 无标记的续行:并入上一行(容错手工编辑);说明/分隔/标题行不入正文。
      current.text += '\n' + raw
    }
  }
  return {
    meta: {
      schema: 1,
      title: meta.title,
      savedAt: Number.isFinite(meta.savedAt) ? meta.savedAt : 0,
      rootTitle: typeof meta.rootTitle === 'string' ? meta.rootTitle : '',
      sessionId: meta.sessionId,
      atSeq: Number.isFinite(meta.atSeq) ? Math.floor(meta.atSeq) : null,
      assistantName: typeof meta.assistantName === 'string' ? meta.assistantName : '',
      turns: Number.isFinite(meta.turns) ? Math.floor(meta.turns) : 0,
      auto: meta.auto === true,
    },
    lines,
  }
}

/** 记录 → 纯文本(内容级回退注入用)。 */
export function linesToText(lines, assistantName) {
  const out = []
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line === null || typeof line !== 'object' || typeof line.text !== 'string' || line.text === '') continue
    const role = line.kind === 'player' ? '玩家' : line.kind === 'assistant' ? (assistantName !== '' ? assistantName : 'AI') : '系统'
    out.push(role + ':' + line.text)
  }
  return out.join('\n')
}

/** 文件名 → 槽位 id(去掉 .md)。 */
export function slotIdFromFileName(name) {
  const value = String(name ?? '')
  return value.toLowerCase().endsWith('.md') ? value.slice(0, -3) : value
}

/** 目录文件名 → 是否匹配某前缀的手动/自动存档,返回 { id, n, auto } 或 null。 */
export function slotFromFileName(name, prefix) {
  const id = slotIdFromFileName(name)
  if (id === '') return null
  const esc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const saveM = new RegExp('^' + esc + '-save(\\d+)$').exec(id)
  if (saveM !== null) return { id, n: parseInt(saveM[1], 10), auto: false }
  const autoM = new RegExp('^' + esc + '-自动(\\d+)$').exec(id)
  if (autoM !== null) return { id, n: parseInt(autoM[1], 10), auto: true }
  return null
}

/** 从目录里已有的文件名算下一个槽位名(同名已存在则递增;返回无扩展名的 id)。 */
export function nextFileSlotId(prefix, existingIds, auto) {
  let max = 0
  for (const id of existingIds) {
    const m = auto
      ? new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-自动(\\d+)$').exec(id)
      : new RegExp('^' + String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-save(\\d+)$').exec(id)
    if (m !== null) {
      const n = parseInt(m[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return String(prefix) + (auto ? '-自动' : '-save') + (max + 1)
}

/** 主线程前缀(与旧槽命名共用规则)。 */
export function fileSlotPrefix(rootTitle) {
  return saveRootPrefix(rootTitle)
}

/**
 * 会话祖先判定:ancestorId 是否在 id 的父链上(含相等)。
 * byId 形状与 sessions 列表快照一致(parentId/parentSessionId 字段兜底)。
 * 读档前用它校验"存档会话是否仍在当前主线的世界线祖先链上"——
 * 不在链上时 fork-atSeq 会静默切到最后一个完成回合,内容漂移,必须降级。
 */
export function isAncestorOf(byId, ancestorId, id) {
  if (typeof ancestorId !== 'string' || ancestorId === '' || typeof id !== 'string' || id === '') return false
  let cursor = id
  let depth = 0
  while (cursor !== '' && depth < 128) {
    if (cursor === ancestorId) return true
    const entry = byId?.[cursor]
    if (entry === null || entry === undefined) return false
    const parent = typeof entry.parentId === 'string' && entry.parentId !== ''
      ? entry.parentId
      : (typeof entry.parentSessionId === 'string' && entry.parentSessionId !== '' ? entry.parentSessionId : null)
    if (parent === null) return false
    cursor = parent
    depth += 1
  }
  return false
}
