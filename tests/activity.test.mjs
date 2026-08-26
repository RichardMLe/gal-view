import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveActivity } from '../.dsh-plugin/client/transcript.mjs'

const text = t => ({ kind: 'text', text: t })
const reasoning = t => ({ kind: 'reasoning', text: t })
const toolCall = (name, argsRaw, callId) => ({ kind: 'tool-call', callId, name, argsRaw })
const pendingApproval = () => ({ kind: 'approval', key: 'a:1', sessionId: 's', payload: { approvalId: 'x', toolName: 'pwsh' }, respond: () => {} })
const pendingQuestion = () => ({ kind: 'question', key: 'q:1', sessionId: 's', payload: { questions: [] }, respond: () => {} })
const base = { running: true, partial: null, pending: [], runningCalls: [], lastLine: null, promptError: null }

test('非运行：错误与发送失败进入活动行，正常为空', () => {
  assert.deepEqual(deriveActivity({ ...base, running: false, lastLine: { error: true } }), [
    { kind: 'error', text: '出错' },
  ])
  assert.deepEqual(deriveActivity({ ...base, running: false, promptError: { op: 'send' } }), [
    { kind: 'error', text: '发送失败' },
  ])
  assert.deepEqual(deriveActivity({ ...base, running: false }), [])
})

test('等待批准/回答优先置顶且台词稳定（流式不闪烁）', () => {
  const input = { ...base, partial: { blocks: [reasoning('想')] }, pending: [pendingApproval(), pendingQuestion()] }
  const activity = deriveActivity(input)
  assert.equal(activity[0].kind, 'waiting')
  assert.equal(activity[1].kind, 'waiting')
  const again = deriveActivity(input)
  assert.deepEqual(again.map(item => item.text), activity.map(item => item.text))
})

test('思考摘要：人话追加摘要，代码/JSON 行绝不露出', () => {
  const human = deriveActivity({ ...base, partial: { blocks: [reasoning('先看看这个目录里有什么')] } })
  assert.equal(human[0].kind, 'reasoning')
  assert.match(human[0].text, /先看看这个目录/)
  const code = deriveActivity({ ...base, partial: { blocks: [reasoning('{"command": "Get-ChildItem", "description": "列出文件"}')] } })
  assert.equal(code[0].kind, 'reasoning')
  assert.doesNotMatch(code[0].text, /command/)
  assert.doesNotMatch(code[0].text, /[{]|"|\\/)
})

test('工具调用行：显示任务描述，不显示命令与 JSON', () => {
  const args = JSON.stringify({ command: 'Get-ChildItem C:\\x', description: '列出工作区文件' })
  const input = { ...base, partial: { blocks: [toolCall('pwsh', args, 'call-1')] } }
  const activity = deriveActivity(input)
  assert.equal(activity[0].kind, 'tool')
  assert.match(activity[0].text, /列出工作区文件/)
  assert.doesNotMatch(activity[0].text, /command|Get-ChildItem/)
  // 同一 callId 重复推导 → 台词稳定
  const again = deriveActivity(input)
  assert.equal(again[0].text, activity[0].text)
})

test('工具无 description 时回退专用规则（file_path → 读取文件名）', () => {
  const args = JSON.stringify({ file_path: 'C:/docs/AGENTS.md' })
  const activity = deriveActivity({ ...base, partial: { blocks: [toolCall('read', args, 'call-2')] } })
  assert.match(activity[0].text, /AGENTS\.md/)
})

test('生成回复行：开场词 + 正文预览', () => {
  const activity = deriveActivity({ ...base, partial: { blocks: [text('安装完成，一切就绪。')] } })
  assert.equal(activity[0].kind, 'writing')
  assert.match(activity[0].text, /安装完成/)
})

test('执行中的工具成行且含任务描述', () => {
  const activity = deriveActivity({ ...base, runningCalls: [{ callId: 'c1', name: 'pwsh', argsRaw: JSON.stringify({ description: '整理目录' }) }] })
  assert.equal(activity[0].kind, 'tool-running')
  assert.match(activity[0].text, /整理目录/)
})

test('无任何信号时兜底忙碌词', () => {
  const activity = deriveActivity({ ...base, partial: { blocks: [] } })
  assert.equal(activity.length, 1)
  assert.equal(activity[0].kind, 'status')
})

test('不同调用台词多样（大池，40 次至少 12 种不同台词）', () => {
  const lines = new Set()
  for (let i = 0; i < 40; i++) {
    const activity = deriveActivity({
      ...base,
      partial: { blocks: [toolCall('pwsh', JSON.stringify({ description: '任务' + i }), 'call-' + i)] },
    })
    lines.add(activity[0].text)
  }
  assert.ok(lines.size >= 12, '40 次调用只有 ' + lines.size + ' 种台词')
})
