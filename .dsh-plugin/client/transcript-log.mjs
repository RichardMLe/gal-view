// 官方会话日志(his tory RPC 事件) → 人类可读台词行的映射纯逻辑。
// 依据 dsh-client-runtime 官方语义(surface.ts):
//   "The model-visible surface deliberately shadows replaced ranges, so it is the
//    wrong source for a human transcript... Append-origin events are that
//    transcript's durable source material; replacement copies stay model-only."
// 即:type ∈ {user/message, assistant/message, tool/result} 且 surfaceOp==="append"
// 的事件才是人类可读转写的持久来源。本模块零宿主依赖,可单测。

import { contentToText, assistantToText } from './transcript.mjs'

/** 官方"人类转写"面事件类型集合。 */
export const SURFACE_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'tool/result'])

/** 是否为官方认可的转写来源事件(append 来源;替换副本仅供模型,过滤)。 */
export function isAppendSurfaceEvent(event) {
  if (event === null || typeof event !== 'object') return false
  return SURFACE_EVENT_TYPES.includes(event.type) && event.surfaceOp === 'append'
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
    const text = assistantToText(data.blocks)
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
