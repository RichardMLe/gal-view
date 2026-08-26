// 落定闸门（settle gate）纯逻辑：零宿主依赖，可单测。
// 背景：对活跃会话 fork（存档）会在源头制造一次序列扰动，官方会话窗口
// （dsh-client-runtime）走 repairGap → installWindow 整体重装；若重装时尾部
// 尚未落定（settled→running 振荡窗口内），装进去的是不完整尾部 → 对话整段
// 消失、只剩工具调用卡片。固定 2.5s 盲等不是修复——没有任何"真正落定"信号。
// 本模块以主机摘要（会话列表条目 running/completed，耐久层）为准：只有
// running=false 且连续 quietMs 无列表变化，才认为可以安全 fork。

/** 会话列表条目是否已耐久落定（主机摘要视角）。 */
export function settledOf(entry) {
  if (entry === null || entry === undefined) return false
  return entry.running === false
}

/** 是否有已完成回合（blank 新会话或无 completed 标记都算未完成；fork 需要它）。 */
export function hasCompletedTurns(entry) {
  if (entry === null || entry === undefined) return false
  return entry.completed === true && entry.blank !== true
}

/**
 * 等待当前会话落定：running=false（耐久）且连续 quietMs 无列表变化。
 * @param opts.getSnapshot - 返回 sessions 列表快照 { current, byId } 的函数。
 * @param opts.subscribe - 订阅列表变化的函数（返回取消函数）；变化会重置静默计时。
 * @param opts.quietMs - 静默时长（默认 2500ms）。
 * @param opts.timeoutMs - 总超时（默认 30000ms）。
 * @param opts.shouldContinue - 每次轮询前询问是否继续（如运行中回 true 即中止）。
 * @param opts.sleep - 轮询间隔（默认 150ms；测试注入）。
 * @returns { settled, completed, aborted } —— aborted 表示 shouldContinue 中止。
 */
export async function waitSettled(opts) {
  const {
    getSnapshot,
    subscribe,
    quietMs = 2500,
    timeoutMs = 30000,
    shouldContinue,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = opts ?? {}
  if (typeof getSnapshot !== 'function') {
    return { settled: false, completed: false, aborted: false }
  }
  const started = Date.now()
  let lastChange = started
  const off = typeof subscribe === 'function' ? subscribe(() => { lastChange = Date.now() }) : null
  try {
    for (;;) {
      if (typeof shouldContinue === 'function' && shouldContinue() === false) {
        return { settled: false, completed: false, aborted: true }
      }
      const snap = getSnapshot()
      const current = snap !== null && typeof snap === 'object' && typeof snap.current === 'string' && snap.current !== ''
        ? snap.current
        : null
      const entry = current === null ? null : (snap.byId?.[current] ?? null)
      const settled = settledOf(entry)
      const completed = hasCompletedTurns(entry)
      if (settled && Date.now() - lastChange >= quietMs) {
        return { settled: true, completed, aborted: false }
      }
      if (Date.now() - started >= timeoutMs) {
        return { settled: false, completed, aborted: false }
      }
      await sleep(150)
    }
  } finally {
    if (off !== null) off()
  }
}
