import test from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalEnvelope, questionAnswerEnvelope, questionCancelEnvelope,
  emptyDrafts, draftAnswered, draftsComplete, buildAnswers, pendingItems,
  toggleSelected, approvalSceneText,
  respondApproval, respondQuestion, cancelQuestion, questionsOf, toolNameOf, reasonOf,
} from '../.dsh-plugin/client/pending.mjs'

const makeWait = (kind, payload, respond) => ({ kind, key: kind + ':1', sessionId: 's1', payload, respond })
// 新式 v0.1.2 pendingInteraction 实例形状(PendingApproval / PendingQuestion)
const makeNewApproval = (answer) => ({ kind: 'approval', key: 'approval:1', sessionId: 's1', toolName: 'pwsh', callId: 'c1', reason: '需要执行命令', answer })
const makeNewQuestion = (answer, cancel) => ({ kind: 'question', key: 'question:1', sessionId: 's1', questions: [{ id: 'q1', question: '怎么选?', options: [{ label: 'A' }] }], answer, cancel })

test('toggleSelected 多选切换（新增/移除）', () => {
  assert.deepEqual(toggleSelected([], 'A'), ['A'])
  assert.deepEqual(toggleSelected(['A'], 'B'), ['A', 'B'])
  assert.deepEqual(toggleSelected(['A', 'B'], 'A'), ['B'])
})

test('approvalEnvelope 组装官方批准信封', () => {
  const wait = makeWait('approval', { approvalId: 'a1', toolName: 'pwsh', reason: '越权', callId: 'c1' }, () => {})
  assert.deepEqual(approvalEnvelope(wait, 'allowed-once'), {
    ok: true,
    value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
  })
  assert.deepEqual(approvalEnvelope(wait, 'rejected'), {
    ok: true,
    value: { sessionId: 's1', approvalId: 'a1', outcome: 'rejected' },
  })
})

test('questionAnswerEnvelope 组装官方回答信封', () => {
  const wait = makeWait('question', { questions: [] }, () => {})
  assert.deepEqual(questionAnswerEnvelope(wait, [{ id: 'q1', selected: ['A'] }]), {
    ok: true,
    value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['A'] }] } },
  })
})

test('questionCancelEnvelope 取消信封', () => {
  const envelope = questionCancelEnvelope()
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'cancelled')
  assert.equal(typeof envelope.error.message, 'string')
})

test('draftAnswered / draftsComplete 判定', () => {
  assert.equal(draftAnswered({ selected: ['A'], custom: '', skipped: false }), true)
  assert.equal(draftAnswered({ selected: [], custom: '自定义', skipped: false }), true)
  assert.equal(draftAnswered({ selected: [], custom: '', skipped: true }), true)
  assert.equal(draftAnswered({ selected: [], custom: '', skipped: false }), false)
  assert.equal(draftsComplete([{ selected: ['A'], custom: '', skipped: false }, { selected: [], custom: '', skipped: true }]), true)
  assert.equal(draftsComplete([{ selected: [], custom: '', skipped: false }]), false)
})

test('buildAnswers 与官方语义一致（跳过/自定义/多选）', () => {
  const questions = [
    { id: 'q1', multiSelect: false },
    { id: 'q2', multiSelect: true },
    { id: 'q3', multiSelect: false },
  ]
  const drafts = [
    { selected: ['A'], custom: '', skipped: false },
    { selected: ['X', 'Y'], custom: '', skipped: false },
    { selected: [], custom: '手写答案', skipped: false },
  ]
  assert.deepEqual(buildAnswers(questions, drafts), [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['X', 'Y'] },
    { id: 'q3', selected: [], custom: '手写答案' },
  ])
  // 跳过 → 空选中
  const skipped = buildAnswers(questions, [
    { selected: [], custom: '', skipped: true },
    { selected: [], custom: '', skipped: false },
    { selected: [], custom: '', skipped: false },
  ])
  assert.deepEqual(skipped[0], { id: 'q1', selected: [] })
})

test('pendingItems 过滤批准/提问并兼容数组与 Map', () => {
  const a = makeWait('approval', {}, () => {})
  const q = makeWait('question', {}, () => {})
  const junk = { kind: 'steering', respond: () => {} }
  assert.deepEqual(pendingItems([a, q, junk, null]).map(w => w.kind), ['approval', 'question'])
  assert.deepEqual(pendingItems(new Map([['a', a], ['q', q], ['j', junk]])).map(w => w.kind), ['approval', 'question'])
  assert.deepEqual(pendingItems(null), [])
  assert.deepEqual(pendingItems('bogus'), [])
})

test('pendingItems:新式 pendingInteraction 实例(approval/question/plan-review,answer/cancel 动词)', () => {
  const a = makeNewApproval(async () => {})
  const q = makeNewQuestion(async () => {}, async () => {})
  const plan = { ...makeNewQuestion(async () => {}, async () => {}), kind: 'plan-review' }
  assert.deepEqual(pendingItems([a, q, plan]).map(w => w.kind), ['approval', 'question', 'plan-review'])
  // 单个交互对象(快照 Map.get(sessionId) 直传)也接受
  assert.deepEqual(pendingItems(q).map(w => w.kind), ['question'])
  // 新式提问缺 answer → 过滤(不可答载体不进面板)
  const broken = { kind: 'question', questions: [], cancel: async () => {} }
  assert.deepEqual(pendingItems([broken]), [])
  // Map 形状:值即 interaction
  assert.deepEqual(pendingItems(new Map([['s1', a]])).map(w => w.kind), ['approval'])
})

test('respondApproval 双形状:旧式 respond(信封)/新式 answer(直接 outcome)', async () => {
  const oldCalls = []
  const old = makeWait('approval', { approvalId: 'a1' }, env => { oldCalls.push(env); return Promise.resolve({ accepted: true }) })
  await respondApproval(old, 'allowed-once')
  assert.equal(oldCalls[0].value.outcome, 'allowed-once')
  const newCalls = []
  await respondApproval(makeNewApproval(outcome => { newCalls.push(outcome); return Promise.resolve('ok') }), 'rejected')
  assert.deepEqual(newCalls, ['rejected'])
})

test('respondQuestion 双形状:旧式 respond(信封)/新式 answer({answers})', async () => {
  const oldCalls = []
  const old = makeWait('question', { questions: [] }, env => { oldCalls.push(env); return Promise.resolve({ accepted: true }) })
  await respondQuestion(old, [{ id: 'q1', selected: ['A'] }])
  assert.deepEqual(oldCalls[0].value.answer.answers, [{ id: 'q1', selected: ['A'] }])
  const newCalls = []
  await respondQuestion(makeNewQuestion(payload => { newCalls.push(payload); return Promise.resolve('ok') }, async () => {}), [{ id: 'q1', selected: ['A'] }])
  assert.deepEqual(newCalls, [{ answers: [{ id: 'q1', selected: ['A'] }] }])
})

test('cancelQuestion 双形状:旧式 respond(取消信封)/新式 cancel()', async () => {
  const oldCalls = []
  const old = makeWait('question', {}, env => { oldCalls.push(env); return Promise.resolve({ accepted: true }) })
  await cancelQuestion(old)
  assert.equal(oldCalls[0].ok, false)
  assert.equal(oldCalls[0].error.code, 'cancelled')
  let cancelled = false
  await cancelQuestion(makeNewQuestion(async () => {}, () => { cancelled = true; return Promise.resolve('ok') }))
  assert.equal(cancelled, true)
})

test('questionsOf/toolNameOf/reasonOf 双形状读取', () => {
  assert.equal(questionsOf(makeNewQuestion(async () => {}, async () => {})).length, 1)
  assert.equal(questionsOf(makeWait('question', { questions: [{ id: 'x' }] }, () => {})).length, 1)
  assert.equal(questionsOf(makeWait('question', {}, () => {})).length, 0)
  assert.equal(toolNameOf(makeNewApproval(async () => {})), 'pwsh')
  assert.equal(toolNameOf(makeWait('approval', { toolName: 'read' }, () => {})), 'read')
  assert.equal(reasonOf(makeNewApproval(async () => {})), '需要执行命令')
  assert.equal(reasonOf(makeWait('approval', { reason: '旧原因' }, () => {})), '旧原因')
})

test('approvalSceneText：按工具类型游戏化，不泄露代码/JSON', () => {
  // 读取文件：取文件名
  const read = approvalSceneText('read', { argsRaw: JSON.stringify({ file_path: 'C:/deep/x/AGENTS.md' }) })
  assert.match(read, /读取.*AGENTS\.md/)
  // 写文件：destination_path
  const write = approvalSceneText('write', { argsRaw: JSON.stringify({ destination_path: 'C:/deep/x/out.txt' }) })
  assert.match(write, /改动.*out\.txt/)
  // 命令：只取 description，不回显 command 原文
  const cmd = approvalSceneText('pwsh', { argsRaw: JSON.stringify({ command: 'Get-ChildItem -Recurse', description: '列出文件' }) })
  assert.match(cmd, /执行.*列出文件/)
  assert.doesNotMatch(cmd, /Get-ChildItem/)
  // 命令无描述：通用文案
  const cmdBare = approvalSceneText('bash', { argsRaw: JSON.stringify({ command: 'rm -rf /tmp' }) })
  assert.match(cmdBare, /运行一个命令/)
  assert.doesNotMatch(cmdBare, /rm -rf/)
  // 未知工具回退
  assert.match(approvalSceneText('whatever', {}), /whatever/)
  // 非 JSON 参数不崩
  assert.match(approvalSceneText('read', { argsRaw: 'not json' }), /读取/)
})
