import test from 'node:test'
import assert from 'node:assert/strict'
import { isAppendSurfaceEvent, lineFromWireEvent, wireAssistantText, wireEventsToLines, readHistoryResponse, SURFACE_EVENT_TYPES } from '../.dsh-plugin/client/transcript-log.mjs'

test('isAppendSurfaceEvent 只认官方转写来源(append 面,替换副本过滤)', () => {
  assert.equal(isAppendSurfaceEvent(null), false)
  assert.equal(isAppendSurfaceEvent({ type: 'user/message', surfaceOp: 'append' }), true)
  assert.equal(isAppendSurfaceEvent({ type: 'assistant/message', surfaceOp: 'append' }), true)
  assert.equal(isAppendSurfaceEvent({ type: 'tool/result', surfaceOp: 'append' }), true)
  assert.equal(isAppendSurfaceEvent({ type: 'user/message', surfaceOp: 'replace' }), false)
  assert.equal(isAppendSurfaceEvent({ type: 'user/message' }), false)
  assert.equal(isAppendSurfaceEvent({ type: 'turn/start', surfaceOp: 'append' }), false)
  assert.deepEqual(SURFACE_EVENT_TYPES, ['user/message', 'assistant/message', 'tool/result'])
})

test('wireAssistantText:session/page 原始日志形状 data.message.content(type:text)', () => {
  // 官方 jsonl 实测形状(8-29 模组的-save7.zip 取证)
  const wire = wireAssistantText({ turn: 1, step: 1, message: { role: 'assistant', content: [
    { type: 'reasoning', text: '思考过程(不进台词)' },
    { type: 'tool-call', id: 'c1', name: 'glob', arguments: '{}' },
    { type: 'text', text: '你好呀\n第二行' },
  ] } })
  assert.equal(wire, '你好呀\n第二行')
  // legacy 形状兜底:data.blocks + kind:'text'
  const legacy = wireAssistantText({ blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '旧通道答复' }] })
  assert.equal(legacy, '旧通道答复')
  assert.equal(wireAssistantText(null), '')
  assert.equal(wireAssistantText({}), '')
  assert.equal(wireAssistantText({ message: { content: [{ type: 'tool-call' }] } }), '')
})

test('lineFromWireEvent:user/steering → 玩家行,assistant → AI 行,工具结果不进台词', () => {
  const user = lineFromWireEvent({ type: 'user/message', surfaceOp: 'append', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } })
  assert.deepEqual(user, { kind: 'player', text: '你好' })
  const steering = lineFromWireEvent({ type: 'user/message', surfaceOp: 'append', seq: 2, data: { source: { kind: 'steering' }, content: [{ type: 'text', text: '继续' }] } })
  assert.deepEqual(steering, { kind: 'player', text: '继续' })
  // 新通道(官方 jsonl)形状:data.message.content
  const aiWire = lineFromWireEvent({ type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '你好呀' }] } } })
  assert.deepEqual(aiWire, { kind: 'assistant', text: '你好呀' })
  // legacy 形状兜底:data.blocks
  const aiLegacy = lineFromWireEvent({ type: 'assistant/message', surfaceOp: 'append', seq: 4, data: { blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '旧通道答复' }] } })
  assert.deepEqual(aiLegacy, { kind: 'assistant', text: '旧通道答复' })
  assert.equal(lineFromWireEvent({ type: 'tool/result', surfaceOp: 'append', seq: 5, data: {} }), null)
  assert.equal(lineFromWireEvent({ type: 'assistant/message', surfaceOp: 'append', seq: 6, data: { message: { content: [{ type: 'tool-call', name: 'x' }] } } }), null)
  assert.equal(lineFromWireEvent({ type: 'user/message', surfaceOp: 'replace', seq: 7, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '被替换' }] } }), null)
})

test('wireEventsToLines:完整转写(行/总回合/存档点 seq/回合对齐锚点 forkSeq)', () => {
  const events = [
    { event: { type: 'turn/start', seq: 10, data: { turn: 1 } } },
    { event: { type: 'user/message', surfaceOp: 'append', seq: 11, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一问' }] } } },
    { event: { type: 'assistant/message', surfaceOp: 'append', seq: 12, data: { blocks: [{ kind: 'text', text: '第一答' }] } } },
    { event: { type: 'turn/end', seq: 13, data: { turn: 1 } } },
    { event: { type: 'turn/start', seq: 20, data: { turn: 2 } } },
    { event: { type: 'user/message', surfaceOp: 'append', seq: 21, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二问' }] } } },
    { event: { type: 'user/message', surfaceOp: 'replace', seq: 22, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '模型可见副本' }] } } },
  ]
  const result = wireEventsToLines(events)
  assert.equal(result.turns, 2)
  assert.equal(result.atSeq, 22)
  assert.equal(result.forkSeq, 13, 'forkSeq 取最后 turn/end 的 seq')
  assert.deepEqual(result.lines, [
    { kind: 'player', text: '第一问' },
    { kind: 'assistant', text: '第一答' },
    { kind: 'player', text: '第二问' },
  ])
})

test('wireEventsToLines:回合后的杂项事件不污染存档锚点(8-30 n/n+1 回归)', () => {
  // 官方 fork 边界=「第一个 seq ≥ atSeq 的 turn/end」:若锚点落在回合后的
  // 自动标题等杂项事件上,读档会把下一回合也算进来。
  const events = [
    { event: { type: 'turn/start', seq: 1, data: { turn: 1 } } },
    { event: { type: 'user/message', surfaceOp: 'append', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '问' }] } } },
    { event: { type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { message: { content: [{ type: 'text', text: '答' }] } } } },
    { event: { type: 'turn/end', seq: 4, data: { turn: 1 } } },
    { event: { type: 'session/title', seq: 7, data: { title: '自动标题' } } },
  ]
  const result = wireEventsToLines(events)
  assert.equal(result.turns, 1)
  assert.equal(result.atSeq, 7, '窗口尾=杂项事件 seq')
  assert.equal(result.forkSeq, 4, '存档锚点=最后 turn/end seq(不被杂项事件污染)')
})

test('wireEventsToLines:空/垃圾输入安全', () => {
  assert.deepEqual(wireEventsToLines(null), { lines: [], turns: 0, atSeq: null, forkSeq: null })
  assert.deepEqual(wireEventsToLines([]), { lines: [], turns: 0, atSeq: null, forkSeq: null })
  const weird = wireEventsToLines([null, 42, { event: { type: 'x' } }])
  assert.equal(weird.lines.length, 0)
  assert.equal(weird.atSeq, null)
  assert.equal(weird.forkSeq, null)
})

test('readHistoryResponse:官方真实契约 result.value.events(不是 result.events)', () => {
  const events = [{ event: { type: 'turn/start', seq: 1 } }, { event: { type: 'user/message', surfaceOp: 'append', seq: 2 } }]
  const page = readHistoryResponse({ result: { ok: true, value: { events, hasMore: true, projections: undefined } } })
  assert.equal(page.error, null)
  assert.deepEqual(page.events, events)
  assert.equal(page.hasMore, true)
  // 旧错误形状(result.events,无 ok/value 层):显式报错,不再静默读成空页
  const legacy = readHistoryResponse({ result: { events } })
  assert.equal(legacy.error, 'history 返回失败: 未知错误')
  assert.deepEqual(legacy.events, [])
  assert.equal(legacy.hasMore, false)
  // 完全无 result 包裹的扁平形状:显式报错(官方契约必有 result 层)
  const flat = readHistoryResponse({ events })
  assert.equal(flat.error, 'history 响应形状不符(缺 result 层)')
  assert.deepEqual(flat.events, [])
})

test('readHistoryResponse:失败/垃圾输入 → 可读 error', () => {
  const failed = readHistoryResponse({ result: { ok: false, error: 'session not found' } })
  assert.equal(failed.events.length, 0)
  assert.equal(failed.error, 'history 返回失败: session not found')
  const empty = readHistoryResponse(undefined)
  assert.equal(empty.error, 'history 响应为空')
  const junk = readHistoryResponse({ result: { ok: true, value: null } })
  assert.equal(junk.error, null)
  assert.deepEqual(junk.events, [])
  assert.equal(junk.hasMore, false)
})
