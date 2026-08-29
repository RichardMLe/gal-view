// 待决交互（批准/提问）的纯逻辑与信封构造：零 React 依赖，可单测。
// 信封形状对齐官方 dsh-client-ui-conversation（PendingApproval）与
// dsh-client-ui-user-questions（PendingQuestion），走同一 wire 通道。
//
// 载体双形状（升级前/后,实测 v0.1.2）:
// 旧式(会话快照 s.pending 条目):
//   { kind: 'approval' | 'question', key, sessionId, payload, respond(result) }
// 新式(useSessionPendingInteraction 快照 Map<sessionId, interaction> 的值):
//   PendingApproval  { kind:'approval',  key, sessionId, toolName, callId, reason, answer(outcome), delegate() }
//   PendingQuestion  { kind:'question'|'plan-review', key, sessionId, questions, answer({answers}), cancel(), delegate() }
// 只读 leaf 字段、按形状分派动词；不序列化、不复制整个载体。

/** 批准信封。outcome ∈ 'allowed-once' | 'rejected'（官方枚举）。 */
export function approvalEnvelope(wait, outcome) {
  return {
    ok: true,
    value: {
      sessionId: wait.sessionId,
      approvalId: wait.payload.approvalId,
      outcome,
    },
  }
}

/** 提问答案信封。answers: [{ id, selected: string[], custom?: string }]。 */
export function questionAnswerEnvelope(wait, answers) {
  return {
    ok: true,
    value: {
      sessionId: wait.sessionId,
      answer: { answers },
    },
  }
}

/** 取消提问信封（宿主将工具调用解析为已取消）。 */
export function questionCancelEnvelope() {
  return {
    ok: false,
    error: {
      code: 'cancelled',
      message: 'the user closed this question request',
      details: {},
    },
  }
}

/** 批准应答（双形状分派）：旧式 respond(信封) / 新式 answer(直接 outcome)。 */
export function respondApproval(wait, outcome) {
  if (typeof wait.respond === 'function') return wait.respond(approvalEnvelope(wait, outcome))
  if (typeof wait.answer === 'function') return wait.answer(outcome)
  return Promise.reject(new Error('载体无响应通道'))
}

/** 提问应答（双形状分派）：旧式 respond(信封) / 新式 answer({ answers })。 */
export function respondQuestion(wait, answers) {
  if (typeof wait.respond === 'function') return wait.respond(questionAnswerEnvelope(wait, answers))
  if (typeof wait.answer === 'function') return wait.answer({ answers })
  return Promise.reject(new Error('载体无响应通道'))
}

/** 取消提问（双形状分派）：旧式 respond(取消信封) / 新式 cancel()。 */
export function cancelQuestion(wait) {
  if (typeof wait.respond === 'function') return wait.respond(questionCancelEnvelope())
  if (typeof wait.cancel === 'function') return wait.cancel()
  return Promise.reject(new Error('载体无响应通道'))
}

/** 载体问题批次（双形状）：新式 questions 直挂 / 旧式 payload.questions。 */
export function questionsOf(wait) {
  if (Array.isArray(wait.questions)) return wait.questions
  const payload = wait.payload
  if (payload !== null && typeof payload === 'object' && Array.isArray(payload.questions)) return payload.questions
  return []
}

/** 载体工具名（双形状）。 */
export function toolNameOf(wait) {
  const name = typeof wait.toolName === 'string' ? wait.toolName : ''
  if (name !== '') return name
  const payload = wait.payload
  if (payload !== null && typeof payload === 'object' && typeof payload.toolName === 'string') return payload.toolName
  return ''
}

/** 载体批准原因（双形状）。 */
export function reasonOf(wait) {
  const reason = typeof wait.reason === 'string' ? wait.reason : ''
  if (reason !== '') return reason
  const payload = wait.payload
  if (payload !== null && typeof payload === 'object' && typeof payload.reason === 'string') return payload.reason
  return ''
}

/** 初始草稿：每题 { selected: [], custom: '', skipped: false }。 */
export function emptyDrafts(questions) {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

/** 单题是否已可提交（选中项 / 自定义文本 / 跳过）。 */
export function draftAnswered(draft) {
  return draft.selected.length > 0 || draft.custom.trim() !== '' || draft.skipped
}

/** 多选切换：已选则移除，未选则追加（返回新数组）。 */
export function toggleSelected(selected, label) {
  return selected.includes(label)
    ? selected.filter(item => item !== label)
    : [...selected, label]
}

/** 全部题目完成（官方要求答案批次完整）。 */
export function draftsComplete(drafts) {
  return drafts.every(draftAnswered)
}

/**
 * 草稿 → 官方 answers 批次：
 * - 跳过 → { id, selected: [] }
 * - 自定义文本非空且非多选 → 单选 selected 置空，附 custom（官方语义）
 */
export function buildAnswers(questions, drafts) {
  return questions.map((question, index) => {
    const draft = drafts[index]
    if (draft.skipped) return { id: question.id, selected: [] }
    const custom = draft.custom.trim()
    return {
      id: question.id,
      selected: custom === '' || question.multiSelect === true ? draft.selected : [],
      ...(custom === '' ? {} : { custom }),
    }
  })
}

/** 面板可见的载体列表（数组 / Map / 单个交互对象皆可；只保留批准/提问两类）。
 * 兼容旧式 s.pending 条目(respond)与新式 pendingInteraction 实例(answer/cancel)。 */
export function pendingItems(pending) {
  let list
  if (Array.isArray(pending)) list = pending
  else if (pending !== null && typeof pending === 'object' && typeof pending.values === 'function') list = [...pending.values()]
  else if (pending !== null && pending !== undefined) list = [pending]
  else list = []
  return list.filter(wait => wait !== null && typeof wait === 'object'
    && (wait.kind === 'approval' || wait.kind === 'question' || wait.kind === 'plan-review')
    && (typeof wait.respond === 'function'
      || (wait.kind === 'approval' && typeof wait.answer === 'function')
      || ((wait.kind === 'question' || wait.kind === 'plan-review') && Array.isArray(wait.questions) && typeof wait.answer === 'function')))
}

/** 从批准载体参数里解析 JSON（argsRaw/arguments/params/args；非 JSON 返回 null）。 */
function pocketArgs(payload) {
  if (payload === null || typeof payload !== 'object') return null
  for (const key of ['argsRaw', 'arguments', 'params', 'args']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim() !== '') {
      try {
        return JSON.parse(value)
      } catch {
        // 非 JSON 原文：下一个键
      }
    }
  }
  return null
}

/** 从解析出的参数对象挑一句"人话"标签（文件名/路径尾/关键词/描述），绝不回显代码。 */
function pocketLabel(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
  for (const key of ['description', 'task', 'label', 'file_path', 'destination_path', 'path', 'pattern']) {
    const value = parsed[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    if (key === 'file_path' || key === 'destination_path' || key === 'path') {
      const base = value.split(/[\\/]/).pop()
      return base !== '' ? clipShort(base, 32) : clipShort(value, 32)
    }
    if (key === 'pattern') return clipShort(value, 24)
    return clipShort(value, 32)
  }
  return ''
}

/** 短文本截断（不引第三方工具）。 */
function clipShort(text, cap) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim()
  return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned
}

/**
 * 批准卡游戏化文案：按工具类型（读/写/命令/其他）生成女仆口吻的请求，
 * 从不回显代码/JSON（只挑文件名/工具描述）。
 */
export function approvalSceneText(toolName, payload) {
  const name = typeof toolName === 'string' && toolName !== '' ? toolName : '工具'
  const label = pocketLabel(pocketArgs(payload))
  const labelPart = label !== '' ? '「' + label + '」' : ''
  if (/read|search|glob|view|open|cat|list|dir|stat/i.test(name)) {
    return '小鲸鱼想读取' + (labelPart !== '' ? ' ' + labelPart : ' 点资料') + '，可以吗？'
  }
  if (/write|edit|save|patch|append|modify|update|replace|delete|remove|mv|rename|mkdir|touch|copy|str-replace/i.test(name)) {
    return '小鲸鱼想改动' + (labelPart !== '' ? ' ' + labelPart : ' 某个文件') + '，你同意吗？'
  }
  if (/cmd|shell|bash|pwsh|exec|run|spawn|terminal|python|node|powershell|code/i.test(name)) {
    if (labelPart !== '') return '小鲸鱼想执行「' + label + '」，要放行吗？'
    return '小鲸鱼想运行一个命令，你批准一下？'
  }
  if (labelPart !== '') return '小鲸鱼想用「' + name + '」处理' + labelPart + '，可以吗？'
  return '小鲸鱼想用「' + name + '」做点事，你批准吗？'
}
