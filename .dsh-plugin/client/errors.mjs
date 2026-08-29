// UI 层错误文案统一收口(架构前提步骤③-1,规范附录 B2):
// 所有 api 调用经这里转展示文案;组件禁止各自 switch reason 字符串、禁止重复定义 causeText。
// 零 React 依赖,可单测。

/** Result 对象({ok:false, reason})→ 可读原因;非失败 Result → 兜底文案。 */
export function resultReason(result) {
  if (result !== null && typeof result === 'object' && result.ok === false && typeof result.reason === 'string' && result.reason !== '') return result.reason
  return '操作失败'
}

/** 任意异常/值 → 可读信息(Error.message / 字符串 / 兜底)。 */
export function causeText(cause) {
  if (cause === null || cause === undefined) return '操作失败'
  if (typeof cause === 'object' && typeof cause.message === 'string') return cause.message
  return String(cause)
}

/** Result/异常是否带指定机器码(如 dir-unauthorized)。 */
export function hasCode(result, code) {
  return result !== null && typeof result === 'object' && result.code === code
}

/** performFileSave 的 reason → 用户文案(原 GalView requestSave 分支收编,B2)。 */
export function saveFailureText(reason) {
  const r = String(reason ?? '')
  if (r === 'busy') return '已有存档正在进行，请稍候再试'
  if (r === 'interfered') return '存档期间对话发生了变化，已取消本次存档，请重试'
  if (r === 'no-session') return '未找到当前会话'
  if (r.indexOf('empty') === 0) {
    const detail = r.length > 6 ? r.slice(6) : ''
    return detail === '' ? '还没有已完成的对话，先聊两句再存档吧' : '存档点缺失，无法存档（原因：' + detail + '）'
  }
  if (r.indexOf('capture-unavailable') === 0) {
    const detail = r.length > 19 ? r.slice(20) : ''
    return '当前环境无法读取会话记录' + (detail === '' ? '，请重试' : '（' + detail + '）')
  }
  return '存档失败：' + (r === '' ? '未知原因' : r)
}

/** 目录授权类失败的专门文案(dir-unauthorized);非该类返回 null(调用方走通用文案)。 */
export function dirErrorText(cause) {
  if (cause !== null && typeof cause === 'object' && cause.code === 'dir-unauthorized') {
    return '存档文件夹未授权或不可用：请点击上方「选择存档文件夹」用系统选择框重新选择一次，再点存档'
  }
  return null
}
