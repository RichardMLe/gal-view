import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSaveDoc, parseSaveDoc, linesToText, slotIdFromFileName,
  slotFromFileName, nextFileSlotId, fileSlotPrefix, isAncestorOf,
} from '../.dsh-plugin/client/savefile.mjs'

const lines = [
  { kind: 'player', text: '你好呀' },
  { kind: 'assistant', text: '第一行\n第二行' },
  { kind: 'system', text: '出错' },
]

test('buildSaveDoc/parseSaveDoc 往返:元数据与多行文本完整', () => {
  const doc = buildSaveDoc({
    title: '深海脑-save1',
    savedAt: 1730000000000,
    rootTitle: '深海脑探案',
    sessionId: 's-1',
    atSeq: 42,
    assistantName: '雾子',
    turns: 7,
    auto: false,
    lines,
  })
  assert.ok(doc.startsWith('<!-- gal-view-save v1 {'))
  const parsed = parseSaveDoc(doc)
  assert.notEqual(parsed, null)
  assert.equal(parsed.meta.title, '深海脑-save1')
  assert.equal(parsed.meta.sessionId, 's-1')
  assert.equal(parsed.meta.atSeq, 42)
  assert.equal(parsed.meta.turns, 7)
  assert.equal(parsed.meta.auto, false)
  assert.equal(parsed.lines.length, 3)
  assert.deepEqual(parsed.lines[0], { kind: 'player', text: '你好呀' })
  assert.equal(parsed.lines[1].kind, 'assistant')
  assert.equal(parsed.lines[1].text, '第一行\n第二行')
  assert.equal(parsed.lines[2].kind, 'system')
})

test('parseSaveDoc 宽容:非本插件文件/坏头部/空文本 → null,不抛错', () => {
  assert.equal(parseSaveDoc(null), null)
  assert.equal(parseSaveDoc(''), null)
  assert.equal(parseSaveDoc('# 普通 md 文件'), null)
  assert.equal(parseSaveDoc('<!-- gal-view-save v1 {broken json -->'), null)
  assert.equal(parseSaveDoc('<!-- gal-view-save v1 {"schema":2} -->'), null)
  assert.equal(parseSaveDoc('<!-- gal-view-save v1 {"schema":1,"title":1,"sessionId":1} -->'), null)
})

test('parseSaveDoc 自动档标记与缺省字段兜底', () => {
  const doc = buildSaveDoc({ title: 'x', sessionId: 's', atSeq: 3, auto: true, lines: [] })
  const parsed = parseSaveDoc(doc)
  assert.equal(parsed.meta.auto, true)
  assert.equal(parsed.meta.rootTitle, '')
  assert.equal(parsed.meta.savedAt >= 0, true)
})

test('linesToText 角色标记输出(缺省 assistantName 用 AI)', () => {
  const text = linesToText(lines, '雾子')
  assert.match(text, /玩家:你好呀/)
  assert.match(text, /雾子:第一行/)
  const fallback = linesToText([{ kind: 'assistant', text: 'x' }], '')
  assert.match(fallback, /AI:x/)
})

test('slotIdFromFileName / slotFromFileName 识别槽位文件', () => {
  assert.equal(slotIdFromFileName('深海脑-save1.md'), '深海脑-save1')
  assert.equal(slotIdFromFileName('a.md'), 'a')
  // .zip 也必须剥:否则「存档名.zip」会被孤儿检测误判成孤立日志
  assert.equal(slotIdFromFileName('深海脑-save1.zip'), '深海脑-save1')
  assert.equal(slotIdFromFileName('深海脑-自动2.ZIP'), '深海脑-自动2')
  assert.deepEqual(slotFromFileName('深海脑-save12.md', '深海脑'), { id: '深海脑-save12', n: 12, auto: false })
  assert.deepEqual(slotFromFileName('深海脑-自动2.md', '深海脑'), { id: '深海脑-自动2', n: 2, auto: true })
  assert.deepEqual(slotFromFileName('深海脑-自动2.zip', '深海脑'), { id: '深海脑-自动2', n: 2, auto: true })
  assert.equal(slotFromFileName('别的-save1.md', '深海脑'), null)
  assert.equal(slotFromFileName('notes.md', '深海脑'), null)
})

test('nextFileSlotId 取最大号+1(自动/手动分开计数)', () => {
  assert.equal(nextFileSlotId('深海脑', ['深海脑-save1', '深海脑-save9'], false), '深海脑-save10')
  assert.equal(nextFileSlotId('深海脑', [], false), '深海脑-save1')
  assert.equal(nextFileSlotId('深海脑', ['深海脑-save1', '深海脑-自动3'], true), '深海脑-自动4')
  assert.equal(nextFileSlotId('深海脑', [], true), '深海脑-自动1')
})

test('fileSlotPrefix 与旧槽命名共用前 3 字规则', () => {
  assert.equal(fileSlotPrefix('深海脑探案'), '深海脑')
  assert.equal(fileSlotPrefix('  '), 'GAL')
})

test('isAncestorOf:父链判定(相等/后代/反向/断链/缺失)', () => {
  const byId = {
    a: { sessionId: 'a' },
    b: { sessionId: 'b', parentId: 'a' },
    c: { sessionId: 'c', parentSessionId: 'b' },
    d: { sessionId: 'd', parentId: 'x' },
  }
  assert.equal(isAncestorOf(byId, 'a', 'c'), true)
  assert.equal(isAncestorOf(byId, 'b', 'c'), true)
  assert.equal(isAncestorOf(byId, 'c', 'c'), true)
  assert.equal(isAncestorOf(byId, 'c', 'a'), false)
  assert.equal(isAncestorOf(byId, 'a', 'd'), false)
  assert.equal(isAncestorOf(byId, 'z', 'c'), false)
  assert.equal(isAncestorOf(byId, '', 'c'), false)
  assert.equal(isAncestorOf({}, 'a', 'c'), false)
})

test('buildSaveDoc note 说明写入正文,parse 往返不受影响', () => {
  const doc = buildSaveDoc({ title: 't', sessionId: 's', atSeq: 1, note: '官方日志导出失败', lines: [{ kind: 'player', text: 'a' }] })
  assert.match(doc, /说明:官方日志导出失败/)
  const parsed = parseSaveDoc(doc)
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].text, 'a')
})
