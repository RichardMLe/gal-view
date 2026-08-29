// 宿主契约测试(A6):把 v0.1.2 实测契约锁存为断言。
// 上游再升级时先跑本文件:红了 = 契约破坏,先改 host-adapter.mjs 再动业务。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOST_CONTRACT, buildSessionPageRequest, readSessionPageResponse,
  windowTailSeqFromEntries, titleFromProjection, waitSettledSnapshotOf,
} from '../.dsh-plugin/client/host-adapter.mjs'

test('契约快照:网关/分页/快照/DOM 字段与实测一致', () => {
  assert.equal(HOST_CONTRACT.rpcChannel, '/api')
  assert.equal(HOST_CONTRACT.sessionPageEndpoint, 'session/page')
  assert.equal(HOST_CONTRACT.pageRequestEnvelope, 'request')
  assert.deepEqual(HOST_CONTRACT.pageRequestFields, ['address', 'throughSeq', 'beforeSeq', 'maxMessages'])
  assert.deepEqual(HOST_CONTRACT.addressKinds, ['session', 'subagent'])
  assert.deepEqual(HOST_CONTRACT.pageResponseFields, ['records', 'hasMore'])
  assert.deepEqual(HOST_CONTRACT.recordKinds, ['event', 'chunks'])
  assert.ok(HOST_CONTRACT.snapshotFields.includes('running'))
  assert.ok(HOST_CONTRACT.snapshotFields.includes('blank'))
  assert.ok(HOST_CONTRACT.snapshotFields.includes('promptError'))
  assert.ok(!HOST_CONTRACT.snapshotFields.includes('nodes'), '新快照不再有 nodes(gal-view 已迁 legacy 投影)')
  assert.ok(!HOST_CONTRACT.snapshotFields.includes('pending'), '新快照不再有 pending(已迁 useSessionPendingInteraction)')
  assert.deepEqual(HOST_CONTRACT.legacyFields, ['nodes', 'turnTimings', 'turnEnds', 'partial', 'runningCalls'])
  assert.deepEqual(HOST_CONTRACT.pendingInteractionKinds, ['approval', 'question', 'plan-review'])
  assert.equal(HOST_CONTRACT.pendingQuestionKey, 'data-question-key')
  assert.equal(HOST_CONTRACT.dom.composerSeat, 'data-composer-seat')
  assert.equal(HOST_CONTRACT.dom.conversationScroll, 'data-conversation-scroll')
  assert.equal(HOST_CONTRACT.dom.widthHandle, 'data-width-handle')
  assert.equal(HOST_CONTRACT.dom.composerPlaceholder, 'data-composer-placeholder')
})

test('buildSessionPageRequest:session/page 载荷信封 {request}(网关 assertExactArguments 只认 request 键)', () => {
  const full = buildSessionPageRequest('s1', { throughSeq: 42, maxMessages: 50, beforeSeq: 10 })
  assert.deepEqual(full, { request: { address: { kind: 'session', sessionId: 's1' }, throughSeq: 42, maxMessages: 50, beforeSeq: 10 } })
  const minimal = buildSessionPageRequest('s2', { throughSeq: 7 })
  assert.deepEqual(minimal, { request: { address: { kind: 'session', sessionId: 's2' }, throughSeq: 7, maxMessages: 50 } })
  // 信封外不允许任何多余键(网关会报 unexpected)
  assert.deepEqual(Object.keys(full), ['request'])
})

test('readSessionPageResponse:ok 形状 / 失败可读 / 垃圾宽容', () => {
  const ok = readSessionPageResponse({ ok: true, value: { records: [{ type: 'event', event: { seq: 1 } }], hasMore: true } })
  assert.equal(ok.error, null)
  assert.equal(ok.records.length, 1)
  assert.equal(ok.hasMore, true)
  const failed = readSessionPageResponse({ ok: false, error: { code: 'bad-request', message: 'through seq past cursor' } })
  assert.equal(failed.error, 'history 返回失败: through seq past cursor')
  assert.deepEqual(failed.records, [])
  const junk = readSessionPageResponse(undefined)
  assert.equal(junk.error, 'history 返回失败: 未知错误')
  assert.equal(junk.hasMore, false)
})

test('windowTailSeqFromEntries:事件窗口最后一条的 seq(throughSeq 来源)', () => {
  const entries = [
    { type: 'event', event: { seq: 10, type: 'turn/start' } },
    { type: 'chunks', event: { seq: 12 } },
    { type: 'event', event: { seq: 11, type: 'tool/result' } },
  ]
  assert.equal(windowTailSeqFromEntries(entries), 11)
  assert.equal(windowTailSeqFromEntries([]), null)
  assert.equal(windowTailSeqFromEntries(null), null)
  assert.equal(windowTailSeqFromEntries([null, { type: 'event' }, { event: {} }]), null)
})

test('titleFromProjection:投影快照 string 或 {title} 双形状', () => {
  assert.equal(titleFromProjection('深海脑探案'), '深海脑探案')
  assert.equal(titleFromProjection({ title: '模组的' }), '模组的')
  assert.equal(titleFromProjection(null), '')
  assert.equal(titleFromProjection({ title: '' }), '')
  assert.equal(titleFromProjection(42), '')
})

test('waitSettledSnapshotOf:绑定会话快照 → 旧式 {current, byId} 形状', () => {
  const snap = waitSettledSnapshotOf('s1', { running: false, blank: false })
  assert.deepEqual(snap, { current: 's1', byId: { s1: { running: false, completed: true, blank: false } } })
  const running = waitSettledSnapshotOf('s2', { running: true, blank: true })
  assert.equal(running.byId.s2.running, true)
  assert.equal(running.byId.s2.completed, false)
  const empty = waitSettledSnapshotOf('s3', undefined)
  assert.equal(empty.byId.s3.running, false)
})
