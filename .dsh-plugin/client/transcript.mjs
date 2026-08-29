// 会话转录 → Galgame 台词行：纯映射，零宿主依赖，可单测。
// 输入是运行时 ConversationSnapshot 的 legacy nodes（含 user/assistant/steering/
// context/tool-result/command/compaction/turn-error 等），输出统一的行模型：
//   { key, kind: 'player'|'assistant'|'system', text }
// 工具调用/结果不进台词（Galgame 对话框不展示工具噪音）；错误/命令/压缩等事件
// 以系统行进入历史。说话人映射（名字/颜色）也在这里。

import * as persona from './persona.mjs'

/**
 * 剥离 Markdown 语法标记（只去标记、保留正文；不触碰正常标点与数学符号）：
 * 代码围栏、图片、链接、加粗、删除线、斜体、行内代码、标题、引用、分割线、列表序号。
 */
export function stripMarkdown(text) {
  if (typeof text !== 'string') return ''
  return text
    // 代码围栏：去掉 ``` 行与语言标记，保留内部内容
    .replace(/^```[^\n]*$/gm, '')
    // 图片：![...](...) 无正文可显示，整体移除
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    // 链接：[文字](url) → 文字
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    // 加粗 **text** → text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    // 删除线 ~~text~~ → text
    .replace(/~~([^~\n]+)~~/g, '$1')
    // 斜体 *text* → text（前后守卫：不吞掉 2*3、孤星号等正常字符）
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)(?![*\w])/g, '$1$2')
    // 行内代码 `text` → text
    .replace(/`([^`\n]+)`/g, '$1')
    // 标题：# / ## / … → 去掉井号
    .replace(/^#{1,6}[ \t]+/gm, '')
    // 引用：行首 > → 去掉
    .replace(/^>[ \t]?/gm, '')
    // 分割线：--- / *** / ___ → 去掉
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    // 无序列表标记：行首 - / * / + → 去掉
    .replace(/^[-*+][ \t]+/gm, '')
    // 有序列表标记：行首 1. / 2. → 去掉
    .replace(/^\d+\.[ \t]+/gm, '')
}

/**
 * 对话文本清洗：先剥离 Markdown 标记，再统一换行符；纯空白行视为空行；
 * 连续多个空行折叠为一个段落分隔；去首尾空行。流式与定稿共用同一函数
 * （contentToText/assistantToText 内应用），避免模型输出的 Markdown 语法与成串
 * 空行占据文本框空间，且定稿切换时文本不重打。
 */
export function cleanDialogueText(text) {
  if (typeof text !== 'string') return ''
  return stripMarkdown(text)
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 用户消息的 content blocks → 纯文本。 */
export function contentToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return cleanDialogueText(blocks
    .map(block => {
      if (block === null || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      return ''
    })
    .filter(text => text !== '')
    .join('\n'))
}

/** 助手消息的 blocks → 纯文本（只取 text 块；reasoning/tool-call 不进台词）。 */
export function assistantToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return cleanDialogueText(blocks
    .map(block => {
      if (block === null || typeof block !== 'object') return ''
      if (block.kind === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(text => text !== '')
    .join('\n'))
}

/** 流式 partial 的文本（正在生成的当前行）。 */
export function partialToText(partial) {
  if (partial === null || typeof partial !== 'object') return ''
  return assistantToText(partial.blocks)
}

/**
 * AI 运行状态（流式 partial 块推导）：
 * - 有正文块 → null（正在输出实际对话，无需状态）；
 * - 有思考块 → '思考中'；
 * - 其余一切非思考、非对话的操作（工具调用/未知块/尚未产生任何块）→ '编写代码中'。
 * 非运行中由调用方不显示。
 */
export function partialStatus(partial) {
  if (partial === null || typeof partial !== 'object' || !Array.isArray(partial.blocks)) return null
  const blocks = partial.blocks
  const hasTool = blocks.some(b => b !== null && typeof b === 'object' && b.kind === 'tool-call')
  const hasReasoning = blocks.some(b => b !== null && typeof b === 'object' && b.kind === 'reasoning' && (b.text ?? '') !== '')
  const hasText = blocks.some(b => b !== null && typeof b === 'object' && b.kind === 'text' && (b.text ?? '') !== '')
  if (hasText && !hasTool) return null
  if (hasReasoning && !hasTool) return '思考中'
  // 工具调用，或任何非思考、非对话的状态（未知块/空块/等待阶段）→ 编写代码中。
  return '编写代码中'
}

/**
 * 完整状态推导（归类所有会话状态）：
 * - 非运行：最后一行是错误（turn-error）→ '出错'；发送失败（promptError op=send）→ '发送失败'。
 * - 运行中：有待回应（批准/提问）→ '等待回应'；正在生成正文 → '思考中'（流式期间不渲染正文，
 *   定稿后才渲染）；思考 → '思考中'；其余（工具调用/工具执行/未知/空）统一 → '编写代码中'（不再附注工具名）。
 */
export function deriveStatus({ running, partial, pending = [], lastLine = null, promptError = null }) {
  if (!running) {
    if (lastLine !== null && lastLine.error === true) return '出错'
    if (promptError !== null && typeof promptError === 'object' && promptError.op === 'send') return '发送失败'
    return null
  }
  if (Array.isArray(pending) && pending.length > 0) return '等待回应'
  const hasText = partial !== null && typeof partial === 'object' && Array.isArray(partial.blocks)
    && partial.blocks.some(b => b !== null && typeof b === 'object' && b.kind === 'text' && (b.text ?? '') !== '')
  // 生成正文期间状态页显示「思考中」（流式不渲染正文，定稿后才渲染回复）。
  if (hasText) return '思考中'
  // 工具调用与工具执行合并为一个状态（不再附注工具名）。
  return partialStatus(partial) ?? '编写代码中'
}

/**
 * 活动行模型：{ kind, text }。
 * kind：reasoning（思考语气词/摘要）/ tool（拟人化调用工具）/ tool-running（执行工具中）/
 *       writing（生成回复预览）/ waiting（等待批准/回答）/ error（出错/发送失败）/ status（兜底）。
 * 台词经 persona.mjs 拟人化：只显示任务描述，绝不回显代码/JSON。
 */
function lastPreviewLine(text, cap = 80) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return ''
  const last = lines[lines.length - 1]
  return last.length > cap ? last.slice(0, cap) + '…' : last
}

function dedupeActivity(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = item.kind + ':' + item.text
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 结构化活动推导：把长链思考的运行状态展开为多条拟人化状态行
 * （思考语气词 / 任务描述式工具调用 / 生成预览 / 等待决定 / 错误）。
 * 输入与 deriveStatus 同源；返回活动行数组（空数组 = 无需显示）。
 * @param personaCfg - scene.settings.persona 归一化配置（未传 = 默认人设）。
 */
export function deriveActivity({ running, partial, pending = [], runningCalls = [], lastLine = null, promptError = null, personaCfg = null }) {
  if (!running) {
    const items = []
    if (lastLine !== null && lastLine.error === true) items.push({ kind: 'error', text: '出错' })
    if (promptError !== null && typeof promptError === 'object' && promptError.op === 'send') items.push({ kind: 'error', text: '发送失败' })
    return items
  }
  const items = []
  // 等待批准/回答优先置顶（种子取首个载体的 key，流式期间台词稳定）。
  if (Array.isArray(pending)) {
    const approvals = pending.filter(wait => wait !== null && typeof wait === 'object' && wait.kind === 'approval')
    const questions = pending.filter(wait => wait !== null && typeof wait === 'object' && (wait.kind === 'question' || wait.kind === 'plan-review'))
    const seed = approvals[0]?.key ?? questions[0]?.key ?? 'pending'
    if (approvals.length > 0) items.push({ kind: 'waiting', text: persona.waitApprovalLine(seed, personaCfg) })
    if (questions.length > 0) items.push({ kind: 'waiting', text: persona.waitQuestionLine(seed, personaCfg) })
  }
  // 流式块：思考语气词 / 拟人化工具调用 / 生成预览。
  if (partial !== null && typeof partial === 'object' && Array.isArray(partial.blocks)) {
    let salt = 0
    for (const block of partial.blocks) {
      if (block === null || typeof block !== 'object') continue
      if (block.kind === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
        // 传全文：语气词种子取首行（流式稳定），摘要取末行（实时演变）；
        // salt=块序号：相邻块语气词不重复，同一块跨渲染稳定。
        const line = persona.thinkingLine(block.text, personaCfg, salt)
        if (line !== '') items.push({ kind: 'reasoning', text: line })
      } else if (block.kind === 'tool-call') {
        const name = typeof block.name === 'string' && block.name !== '' ? block.name : '工具'
        const callId = typeof block.callId === 'string' ? block.callId : ''
        const task = persona.taskOf(block.argsRaw, name)
        items.push({ kind: 'tool', text: persona.toolLine(task, callId !== '' ? callId : task, personaCfg, salt) })
      } else if (block.kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        const preview = lastPreviewLine(block.text, 80)
        if (preview !== '') items.push({ kind: 'writing', text: persona.writingLine(preview, personaCfg, salt) })
      }
      salt += 1
    }
  }
  // 执行中的工具：与「准备调用」是不同阶段，各自成行；完全相同的行去重。
  if (Array.isArray(runningCalls)) {
    let salt = 0
    for (const call of runningCalls) {
      if (call === null || typeof call !== 'object') continue
      const name = typeof call.name === 'string' && call.name !== '' ? call.name : null
      if (name === null) continue
      const task = persona.taskOf(call.argsRaw, name)
      items.push({ kind: 'tool-running', text: persona.runningLine(task, personaCfg, salt) })
      salt += 1
    }
  }
  const deduped = dedupeActivity(items)
  if (deduped.length > 0) return deduped
  return [{ kind: 'status', text: persona.idleLine('idle', personaCfg) }]
}

/** 单个会话节点 → 行（无文本/工具类返回 null 跳过）。 */
export function lineFromNode(node) {
  if (node === null || typeof node !== 'object') return null
  const key = 'node-' + String(node.seq ?? 'x')
  switch (node.kind) {
    case 'user': {
      const text = contentToText(node.content)
      return text === '' ? null : { key, kind: 'player', text }
    }
    case 'steering': {
      const text = contentToText(node.content)
      return text === '' ? null : { key, kind: 'player', text }
    }
    case 'assistant': {
      const text = assistantToText(node.blocks)
      return text === '' ? null : { key, kind: 'assistant', text }
    }
    case 'context': {
      const text = contentToText(node.content)
      return text === '' ? null : { key, kind: 'system', text: '[上下文] ' + text }
    }
    case 'command': {
      const name = typeof node.name === 'string' ? node.name : ''
      const args = typeof node.args === 'string' ? node.args : '' // args 自带分隔空白
      const failed = node.outcome?.kind === 'error' && typeof node.outcome.text === 'string'
      return { key, kind: 'system', text: (failed ? '[命令失败] /' : '/') + name + args }
    }
    case 'compaction': {
      const summary = typeof node.summary === 'string' && node.summary !== ''
      return { key, kind: 'system', text: summary ? '[对话压缩] ' + node.summary : '[对话压缩检查点]' }
    }
    case 'turn-error': {
      return { key, kind: 'system', text: '[错误] ' + String(node.message ?? '回合失败'), error: true }
    }
    case 'model-retry': {
      return { key, kind: 'system', text: '[等待模型重试]' }
    }
    case 'turn-max-tokens': {
      return { key, kind: 'system', text: '[已达到输出上限]' }
    }
    case 'unknown': {
      return { key, kind: 'system', text: '[未知事件 ' + String(node.type ?? '') + ']' }
    }
    default:
      // tool-result 等：不进台词。
      return null
  }
}

/** 节点列表 → 行列表（保持日志顺序，过滤空行）。 */
export function nodesToLines(nodes) {
  if (!Array.isArray(nodes)) return []
  const out = []
  for (const node of nodes) {
    const line = lineFromNode(node)
    if (line !== null) out.push(line)
  }
  return out
}

/**
 * 新版 useChat(s=>s.legacy) 兼容投影 → 旧式视图状态(带安全默认)。
 * 上游 v0.1.2 起 SessionSnapshot 不再携带 nodes/turnEnds/partial/runningCalls,
 * 官方在 ChatSnapshot 里保留 legacy 投影,条目形状与旧式一致(kind/seq/content/blocks,
 * 实测 legacyContribution/rebuildFinalized:按 left.seq 排序)。本函数只做归一化,
 * 不改变任何条目;gal-view 的 lineFromNode/partialToText/deriveActivity 直接消费。
 */
export function legacyToViewState(legacy) {
  const src = legacy !== null && typeof legacy === 'object' ? legacy : {}
  return {
    nodes: Array.isArray(src.nodes) ? src.nodes : [],
    turnEnds: src.turnEnds instanceof Map ? src.turnEnds : new Map(),
    partial: src.partial !== null && typeof src.partial === 'object' ? src.partial : null,
    runningCalls: Array.isArray(src.runningCalls) ? src.runningCalls : [],
  }
}

/** 系统说话人的名字（对话框名牌据此隐藏；历史面板仍显示系统行标签）。 */
export const SYSTEM_NAME = '系统'

/** 系统说话人（固定）。 */
export function systemSpeaker() {
  return { name: SYSTEM_NAME, color: '#8f9bbd' }
}

/** 玩家说话人（名字可配置）。 */
export function playerSpeaker(scene) {
  const name = scene.settings.playerName
  return { name: name === '' ? '你' : name, color: '#4f8cff' }
}

/** 助手说话人：settings.assistantSpeaker 指向的角色元素；失效时退回系统。 */
export function assistantSpeaker(scene) {
  const el = scene.elements.find(e => e.id === scene.settings.assistantSpeaker)
  if (el !== undefined && el.type === 'character' && el.character) {
    return { name: el.character.name, color: el.character.color }
  }
  return systemSpeaker()
}

/** 指定角色的名牌元素（speaker-name + role）；不存在返回 null。 */
export function roleNameElement(scene, role) {
  return scene.elements.find(el => el.type === 'speaker-name' && el.role === role) ?? null
}

/** 玩家显示名：优先玩家名牌元素的文本（用户自定义），空/缺失回退设置里的玩家名。 */
export function playerDisplayName(scene) {
  const el = roleNameElement(scene, 'player')
  if (el !== null && el.text !== '') return el.text
  return playerSpeaker(scene).name
}

/** AI 显示名：优先 AI 名牌元素的文本（用户自定义），空/缺失回退助手角色名/系统。 */
export function assistantDisplayName(scene) {
  const el = roleNameElement(scene, 'assistant')
  if (el !== null && el.text !== '') return el.text
  return assistantSpeaker(scene).name
}

/** 行 → 说话人（名字优先取名牌元素；颜色也随元素 color，元素缺失时回退旧配色）。 */
export function speakerFor(scene, kind) {
  switch (kind) {
    case 'player': {
      const el = roleNameElement(scene, 'player')
      return { name: playerDisplayName(scene), color: el?.color ?? playerSpeaker(scene).color }
    }
    case 'assistant': {
      const el = roleNameElement(scene, 'assistant')
      return { name: assistantDisplayName(scene), color: el?.color ?? assistantSpeaker(scene).color }
    }
    default: return systemSpeaker()
  }
}

/** 欢迎行：空会话（blank）时展示的占位台词。 */
export function welcomeLine(scene) {
  const lines = scene.settings.welcome
  if (lines.length === 0) return null
  return { key: 'welcome', kind: 'assistant', text: lines.join('\n\n') }
}
