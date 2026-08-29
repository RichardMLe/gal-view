// 错误口径统一(架构前提步骤③-1,规范附录 B2)测试:
// UI 收口助手 resultReason/causeText/hasCode/saveFailureText/dirErrorText。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resultReason, causeText, hasCode, saveFailureText, dirErrorText } from '../.dsh-plugin/client/errors.mjs'

test('resultReason:失败 Result 取 reason,其余兜底', () => {
  assert.equal(resultReason({ ok: false, reason: '存档文件夹未授权' }), '存档文件夹未授权')
  assert.equal(resultReason({ ok: false }), '操作失败')
  assert.equal(resultReason({ ok: true, value: 1 }), '操作失败')
  assert.equal(resultReason(null), '操作失败')
  assert.equal(resultReason(undefined), '操作失败')
})

test('causeText:Error.message / 字符串 / 兜底', () => {
  assert.equal(causeText(new Error('写入失败')), '写入失败')
  assert.equal(causeText({ message: '对象消息' }), '对象消息')
  assert.equal(causeText('字符串原因'), '字符串原因')
  assert.equal(causeText(null), '操作失败')
  assert.equal(causeText(42), '42')
})

test('hasCode:Result 机器码判定', () => {
  assert.equal(hasCode({ ok: false, reason: 'x', code: 'dir-unauthorized' }, 'dir-unauthorized'), true)
  assert.equal(hasCode({ ok: false, reason: 'x' }, 'dir-unauthorized'), false)
  assert.equal(hasCode(null, 'dir-unauthorized'), false)
})

test('saveFailureText:performFileSave reason → 用户文案(原 requestSave 分支收编)', () => {
  assert.equal(saveFailureText('busy'), '已有存档正在进行，请稍候再试')
  assert.equal(saveFailureText('interfered'), '存档期间对话发生了变化，已取消本次存档，请重试')
  assert.equal(saveFailureText('no-session'), '未找到当前会话')
  assert.equal(saveFailureText('empty'), '还没有已完成的对话，先聊两句再存档吧')
  assert.equal(saveFailureText('empty;history 转写不可用(x)且窗口转写无存档点'), '存档点缺失，无法存档（原因：history 转写不可用(x)且窗口转写无存档点）')
  assert.equal(saveFailureText('capture-unavailable: x'), '当前环境无法读取会话记录（ x）')
  assert.equal(saveFailureText(''), '存档失败：未知原因')
  assert.equal(saveFailureText('其他'), '存档失败：其他')
})

test('dirErrorText:dir-unauthorized 专门文案,其余 null', () => {
  assert.match(dirErrorText({ code: 'dir-unauthorized' }), /选择存档文件夹/)
  assert.equal(dirErrorText({ code: 'other' }), null)
  assert.equal(dirErrorText(null), null)
})
