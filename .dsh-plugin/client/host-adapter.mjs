// ============================================================================
// 宿主适配层(host-adapter):gal-view 对 DSH 官方界面的【唯一】读写通道。
// 架构前提 A1:官方契约全部集中于此,升级时先跑 tests/host-contract.test.mjs,
// 破了只改本文件。每个契约标注来源(包名/行号/实测版本)。
// 二阶段(管家)所有新增代码也只经本层访问宿主,严禁直接 ctx.get/querySelector。
// 实测版本:上游 v0.1.2-alpha.1(DSH Desktop v2.0.4,2026-08-29 取证)。
// ============================================================================

/**
 * 契约快照:上游 v0.1.2 实测接口形状(数据本身,供契约测试断言与升级比对)。
 * 来源:
 * - sessions 服务面:@deepseek-ai/dsh-api-session-controller
 *   lib/types/client/sessions/service.js(provide('sessions') + open/fork/binding)
 * - SessionSnapshot:运行时 inspect 实时查询(队列/草稿/运行态字段)
 * - session/page:@deepseek-ai/dsh-api-session-controller typert 定义
 *   (SessionPageRequest/SessionPage)+ @deepseek-ai/dsh-api-gateway
 *   lib/types/client/index.js(rpc.call('/api', endpoint, { args }))
 * - ChatSnapshot.legacy:@deepseek-ai/dsh-client-ui-chat LegacySliceBuilder
 * - DOM 属性:@deepseek-ai/dsh-client-ui-conversation ConversationRoot/InputBar
 */
export const HOST_CONTRACT = Object.freeze({
  // rpc 网关
  rpcChannel: '/api',
  sessionPageEndpoint: 'session/page',
  // session/page 请求字段(throughSeq 必须 ≤ 日志尾 seq,主机校验)
  pageRequestFields: ['address', 'throughSeq', 'beforeSeq', 'maxMessages'],
  addressKinds: ['session', 'subagent'],
  // session/page 响应
  pageResponseFields: ['records', 'hasMore'],
  recordKinds: ['event', 'chunks'],
  // SessionSnapshot(新面)存在字段(gal-view 依赖:running/blank/promptError)
  snapshotFields: ['sessionId', 'queue', 'pendingSubmissions', 'running', 'subagent', 'removed', 'openState', 'openError', 'hasMore', 'loadingOlder', 'promptError', 'blank', 'lastAgentError', 'promptAttempted', 'awaitingFirstTurn'],
  // ChatSnapshot.legacy 兼容投影字段(gal-view 对话数据源)
  legacyFields: ['nodes', 'turnTimings', 'turnEnds', 'partial', 'runningCalls'],
  // DOM 稳定属性(隐式契约,升级先查)
  dom: Object.freeze({
    conversationScroll: 'data-conversation-scroll',
    composerSeat: 'data-composer-seat',
    widthHandle: 'data-width-handle',
    composerPlaceholder: 'data-composer-placeholder',
    composerEditablePlaceholder: 'data-placeholder', // contenteditable 宿主
    legacyTextareaPhase: 'data-phase', // 旧壳占位符 textarea(兼容)
    sessionAreaFills: 'data-gal-fills', // gal-view 自身标记
  }),
  // conversation.view 标准 props(gal-view 可用)
  viewStandardProps: ['useSession', 'useChat', 'useInput', 'inputActions', 'useProjection', 'sessionId', 'useConversation', 'useSessionPendingInteraction'],
})

/**
 * 惰性服务代理:上游启动顺序可能导致插件 apply 早于服务挂载,
 * 闭包快照会永远 undefined(读档"不支持会话分叉"的真因)。
 * 每次属性访问实时 ctx.get 解析,方法自动绑定服务实例(不吞 this)。
 */
export function lazyService(ctx, name) {
  return new Proxy({}, {
    get: (_t, key) => {
      const s = ctx.get(name)
      if (s === null || s === undefined) return undefined
      const v = s[key]
      return typeof v === 'function' ? v.bind(s) : v
    },
  })
}

/** 组装 session/page 请求(纯函数,契约测试覆盖)。 */
export function buildSessionPageRequest(sessionId, opts = {}) {
  const payload = {
    address: { kind: 'session', sessionId },
    throughSeq: opts.throughSeq,
    maxMessages: opts.maxMessages ?? 50,
  }
  if (typeof opts.beforeSeq === 'number') payload.beforeSeq = opts.beforeSeq
  return payload
}

/** 解析 session/page 响应(纯函数,宽容但显式报错;契约测试覆盖)。 */
export function readSessionPageResponse(response) {
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    const detail = response !== null && typeof response === 'object' && response.error !== null && typeof response.error === 'object'
      ? String(response.error.message ?? response.error.code ?? '')
      : '未知错误'
    return { records: [], hasMore: false, error: 'history 返回失败: ' + detail }
  }
  const value = response.value !== null && typeof response.value === 'object' ? response.value : {}
  const records = Array.isArray(value.records) ? value.records : []
  return { records, hasMore: value.hasMore === true, error: null }
}

/** 会话事件窗口最后一条的 seq(throughSeq 来源;纯函数)。 */
export function windowTailSeqFromEntries(entries) {
  if (!Array.isArray(entries)) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const seq = entry !== null && typeof entry === 'object' && entry.event !== null && typeof entry.event === 'object'
      ? entry.event.seq
      : null
    if (typeof seq === 'number') return seq
  }
  return null
}

/** title 投影 → 标题字符串(纯函数;投影快照可能是 string 或 {title})。 */
export function titleFromProjection(snapshot) {
  if (typeof snapshot === 'string' && snapshot !== '') return snapshot
  if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string' && snapshot.title !== '') return snapshot.title
  return ''
}

/** 绑定会话快照 → 旧式 { current, byId } 落定闸门形状(纯函数)。 */
export function waitSettledSnapshotOf(id, sessionSnapshot) {
  const snap = sessionSnapshot !== null && typeof sessionSnapshot === 'object' ? sessionSnapshot : {}
  return {
    current: id,
    byId: {
      [id]: {
        running: snap.running === true,
        completed: !(snap.blank === true),
        blank: snap.blank === true,
      },
    },
  }
}

// ----------------------------------------------------------------------------
// DOM 钩子(全部走 HOST_CONTRACT.dom 的稳定属性;升级先查契约测试)
// ----------------------------------------------------------------------------

/** GAL 激活期间:隐藏官方输入席 + 正文宽度拖拽手柄,打 fills 标记;卸载恢复。
 * 返回恢复函数;找不到外壳(独立挂载/冒烟)时静默跳过。 */
export function hideShellChromeForGal(root) {
  if (root === null || root === undefined) return () => {}
  const scrollBody = root.closest('[' + HOST_CONTRACT.dom.conversationScroll + ']')
  const seat = scrollBody !== null
    ? scrollBody.querySelector(':scope > [' + HOST_CONTRACT.dom.composerSeat + ']')
    : null
  if (scrollBody === null || seat === null) return () => {}
  const prev = {
    seatDisplay: seat.style.display,
    overflow: scrollBody.style.overflow,
    position: scrollBody.style.position,
  }
  seat.style.display = 'none'
  scrollBody.style.overflow = 'hidden'
  scrollBody.style.position = 'relative'
  root.setAttribute(HOST_CONTRACT.dom.sessionAreaFills, '')
  const handles = scrollBody.parentElement !== null
    ? scrollBody.parentElement.querySelectorAll('[' + HOST_CONTRACT.dom.widthHandle + ']')
    : []
  const savedHandles = []
  handles.forEach((el) => {
    savedHandles.push([el, el.style.display])
    el.style.display = 'none'
  })
  return () => {
    seat.style.display = prev.seatDisplay
    scrollBody.style.overflow = prev.overflow
    scrollBody.style.position = prev.position
    root.removeAttribute(HOST_CONTRACT.dom.sessionAreaFills)
    savedHandles.forEach(([el, display]) => {
      el.style.display = display
    })
  }
}

/** 官方「对话」栏输入占位符改为鲸鱼娘文案(新壳 contentEditable + 旧壳 textarea 双适配)。 */
export function applyComposerPlaceholder(text) {
  for (const input of document.querySelectorAll('textarea[' + HOST_CONTRACT.dom.legacyTextareaPhase + ']')) {
    if (input.getAttribute('placeholder') !== text) input.setAttribute('placeholder', text)
  }
  for (const el of document.querySelectorAll('[' + HOST_CONTRACT.dom.composerPlaceholder + ']')) {
    if (el.textContent !== text) el.textContent = text
  }
  for (const el of document.querySelectorAll('[contenteditable="true"][' + HOST_CONTRACT.dom.composerEditablePlaceholder + ']')) {
    if (el.getAttribute(HOST_CONTRACT.dom.composerEditablePlaceholder) !== text) el.setAttribute(HOST_CONTRACT.dom.composerEditablePlaceholder, text)
  }
}
