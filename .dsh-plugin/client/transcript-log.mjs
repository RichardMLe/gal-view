// 官方会话日志(his tory RPC 事件) → 人类可读台词行的映射纯逻辑。
// 依据 dsh-client-runtime 官方语义(surface.ts):
//   "The model-visible surface deliberately shadows replaced ranges, so it is the
//    wrong source for a human transcript... Append-origin events are that
//    transcript's durable source material; replacement copies stay model-only."
// 即:type ∈ {user/message, assistant/message, tool/result} 且 surfaceOp==="append"
// 的事件才是人类可读转写的持久来源。本模块零宿主依赖,可单测。

import { contentToText, cleanDialogueText } from './transcript.mjs'

/** 官方"人类转写"面事件类型集合。 */
export const SURFACE_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/result'])

/** 是否为官方认可的转写来源事件(append 来源;替换副本仅供模型,过滤)。 */
export function isAppendSurfaceEvent(event) {
  if (event === null || typeof event !== 'object') return false
  return SURFACE_EVENT_TYPES.includes(event.type) && event.surfaceOp === 'append'
}

/** 助手消息文本提取(双形状,契约测试覆盖):
 * - session/page 通道:原始日志形状 data.message.content,文本块 type:'text'
 *   (官方 jsonl 实测:assistant/message.data = { turn, step, message:{ role, content:[{type:'text'|'reasoning'|'tool-call',...}] }, usage });
 * - legacy history 通道:data.blocks,文本块 kind:'text'。
 * 只取 text 块:reasoning/tool-call 不进台词。 */
export function wireAssistantText(data) {
  if (data === null || typeof data !== 'object') return ''
  const message = data.message
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content)
    ? message.content
    : (Array.isArray(data.blocks) ? data.blocks : null)
  if (blocks === null) return ''
  return cleanDialogueText(blocks
    .map(block => {
      if (block === null || typeof block !== 'object') return ''
      const isText = block.type === 'text' || block.kind === 'text'
      return isText && typeof block.text === 'string' ? block.text : ''
    })
    .filter(text => text !== '')
    .join('\n'))
}

/** 单个线事件 → 台词行;无文本/非转写事件返回 null。 */
export function lineFromWireEvent(event) {
  if (!isAppendSurfaceEvent(event)) return null
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'user/message') {
    const kind = data.source !== null && typeof data.source === 'object' ? data.source.kind : undefined
    if (kind !== 'user' && kind !== 'steering') return null
    const text = contentToText(data.content)
    return text === '' ? null : { kind: 'player', text }
  }
  if (event.type === 'assistant/message') {
    const text = wireAssistantText(data)
    return text === '' ? null : { kind: 'assistant', text }
  }
  // tool/result:工具噪音不进台词(Galgame 对话框不展示),完整内容见官方日志 zip。
  return null
}

/**
 * 事件列表(history RPC 累积,含 {event} 或裸 event)→ { lines, turns, atSeq }。
 * turns = turn/start 计数(持久总回合数);atSeq = 最后一个事件 seq(存档锚点)。
 */
export function wireEventsToLines(entries) {
  const lines = []
  let turns = 0
  let atSeq = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    const event = entry !== null && typeof entry === 'object' && entry.event !== undefined && entry.event !== null
      ? entry.event
      : entry
    if (event === null || typeof event !== 'object') continue
    if (typeof event.seq === 'number' && Number.isFinite(event.seq)) atSeq = event.seq
    if (event.type === 'turn/start') turns += 1
    const line = lineFromWireEvent(event)
    if (line !== null) lines.push(line)
  }
  return { lines, turns, atSeq }
}

/**
 * 官方 sessions.history RPC 响应 → { events, hasMore, error }。
 * 真实契约(web-runtime doOpen/loadOlder,2026-08 实测源码):
 *   await api.sessions.history({ sessionId, maxMessages, beforeSeq? })
 *   → { result: { ok: boolean, error?: string,
 *        value: { events: [{ event, view }], hasMore: boolean, projections? } } }
 * 注意:事件挂在 result.value.events 下(不是 result.events);旧假设形状导致
 * 真实浏览器里永远读到空页——自动档不触发、手动档误报「还没有已完成对话」的根因。
 * 解析从严:任何不匹配官方契约的形状都返回可读 error(不再静默读成空页)。
 */
export function readHistoryResponse(response) {
  if (response === null || typeof response !== 'object') {
    return { events: [], hasMore: false, error: 'history 响应为空' }
  }
  const result = response.result
  if (result === null || typeof result !== 'object') {
    return { events: [], hasMore: false, error: 'history 响应形状不符(缺 result 层)' }
  }
  if (result.ok !== true) {
    return { events: [], hasMore: false, error: 'history 返回失败: ' + String(result.error ?? '未知错误') }
  }
  const value = result.value !== null && typeof result.value === 'object' ? result.value : {}
  const events = Array.isArray(value.events) ? value.events : []
  return { events, hasMore: value.hasMore === true, error: null }
}
