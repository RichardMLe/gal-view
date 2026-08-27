import test from 'node:test'
import assert from 'node:assert/strict'
import { isAppendSurfaceEvent, lineFromWireEvent, wireEventsToLines, readHistoryResponse, SURFACE_EVENT_TYPES } from '../.dsh-plugin/client/transcript-log.mjs'

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

test('lineFromWireEvent:user/steering → 玩家行,assistant → AI 行,工具结果不进台词', () => {
  const user = lineFromWireEvent({ type: 'user/message', surfaceOp: 'append', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } })
  assert.deepEqual(user, { kind: 'player', text: '你好' })
  const steering = lineFromWireEvent({ type: 'user/message', surfaceOp: 'append', seq: 2, data: { source: { kind: 'steering' }, content: [{ type: 'text', text: '继续' }] } })
  assert.deepEqual(steering, { kind: 'player', text: '继续' })
  const ai = lineFromWireEvent({ type: 'assistant/message', surfaceOp: 'append', seq: 3, data: { blocks: [{ kind: 'reasoning', text: '思考' }, { kind: 'text', text: '你好呀' }] } })
  assert.deepEqual(ai, { kind: 'assistant', text: '你好呀' })
  assert.equal(lineFromWireEvent({ type: 'tool/result', surfaceOp: 'append', seq: 4, data: {} }), null)
  assert.equal(lineFromWireEvent({ type: 'assistant/message', surfaceOp: 'append', seq: 5, data: { blocks: [{ kind: 'tool-call', name: 'x' }] } }), null)
  assert.equal(lineFromWireEvent({ type: 'user/message', surfaceOp: 'replace', seq: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '被替换' }] } }), null)
})

test('wireEventsToLines:完整转写(行/总回合/存档点 seq)', () => {
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
  assert.deepEqual(result.lines, [
    { kind: 'player', text: '第一问' },
    { kind: 'assistant', text: '第一答' },
    { kind: 'player', text: '第二问' },
  ])
})

test('wireEventsToLines:空/垃圾输入安全', () => {
  assert.deepEqual(wireEventsToLines(null), { lines: [], turns: 0, atSeq: null })
  assert.deepEqual(wireEventsToLines([]), { lines: [], turns: 0, atSeq: null })
  const weird = wireEventsToLines([null, 42, { event: { type: 'x' } }])
  assert.equal(weird.lines.length, 0)
  assert.equal(weird.atSeq, null)
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
