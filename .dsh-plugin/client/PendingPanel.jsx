/** 决策面板：游戏模式内渲染 s.pending 的批准/提问载体，经 wait.respond 直接回答。
 * 与「对话」栏官方卡片共用同一 wire 通道：回答后宿主广播 resolved → pending 移除 →
 * 面板自动消失。回答失败显示错误并允许重试（官方同款行为）。
 *
 * Galgame 版式（用户定制）：
 * - 无外层包裹框：金色问题标题 + 蝴蝶结金线分隔 + 垂直并列的大选项框；
 * - 「算了 / 先跳过 / 下一题」与选项并列；自定义回答与「提交」整合进玩家输入框；
 * - 背景虚化轻；选项框边框取「设置」按钮气质（细亮边 + 深色玻璃）。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyDrafts, draftAnswered, draftsComplete, buildAnswers, pendingItems,
  toggleSelected, approvalSceneText,
  respondApproval, respondQuestion, cancelQuestion, questionsOf, toolNameOf, reasonOf,
} from './pending.mjs'

/** 响应失败的可读信息。 */
function causeText(cause) {
  if (cause === null || cause === undefined) return '响应失败'
  if (typeof cause === 'object' && typeof cause.message === 'string') return cause.message
  return String(cause)
}

/** 载体 receipt 被拒 → 抛错进入错误分支。 */
function assertAccepted(receipt) {
  if (receipt !== null && typeof receipt === 'object' && receipt.accepted === false) {
    throw new Error('响应被拒绝')
  }
}

/** 金色蝴蝶结分隔线（金色渐变线 + 皮肤蝴蝶结资产，经 CSS 渲染）。 */
function Divider() {
  return (
    <div className="gv-pending-divider" aria-hidden="true">
      <span className="gv-pending-bow" />
    </div>
  )
}

/** 问题框四角花纹（皮肤侧边栏转角资产，四向翻转复用）。 */
function Corners() {
  return (
    <>
      <span className="gv-pending-corner gv-pending-corner-tl" aria-hidden="true" />
      <span className="gv-pending-corner gv-pending-corner-tr" aria-hidden="true" />
      <span className="gv-pending-corner gv-pending-corner-br" aria-hidden="true" />
      <span className="gv-pending-corner gv-pending-corner-bl" aria-hidden="true" />
    </>
  )
}

/** 批准：金色标题 + 原因 + 两个并列大选项（允许一次 / 拒绝）。 */
function ApprovalCard({ wait }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const answer = (outcome) => {
    if (busy) return
    setBusy(true)
    setError(null)
    respondApproval(wait, outcome).then(assertAccepted, (cause) => {
      setBusy(false)
      setError(causeText(cause))
    })
  }
  const toolName = toolNameOf(wait) !== '' ? toolNameOf(wait) : '工具'
  const reason = reasonOf(wait) !== ''
    ? reasonOf(wait)
    : toolName + ' 请求越权执行，需要你的批准。'
  // 游戏化请求文案（读/写/命令分类 + 参数摘要，绝不回显代码/JSON）；原始原因保留为次级小字。
  const sceneText = approvalSceneText(toolName, wait.payload !== null && typeof wait.payload === 'object' ? wait.payload : { reason: reasonOf(wait) })
  return (
    <div className="gv-pending-approval" role="dialog" aria-label="批准请求">
      <div className="gv-pending-head">
        <Corners />
        <div className="gv-pending-head-row">
          <span className="gv-pending-title">需要你的批准</span>
          <span className="gv-pending-tag">{toolName}</span>
        </div>
        <p className="gv-pending-detail">{sceneText}</p>
        {reason !== sceneText && <p className="gv-pending-reason">{reason}</p>}
      </div>
      <Divider />
      <div className="gv-pending-options">
        <button type="button" className="gv-pending-option is-gold" disabled={busy} onClick={() => answer('allowed-once')}>允许一次</button>
        <button type="button" className="gv-pending-option" disabled={busy} onClick={() => answer('rejected')}>拒绝</button>
      </div>
      {error !== null && <p className="gv-pending-error">{error}</p>}
    </div>
  )
}

/**
 * 提问：金色标题 + 蝴蝶结分隔 + 大选项框。
 * 选择状态内部维护；自定义回答与「提交」由玩家输入框承载（经 draft/setSharedDraft 共享）；
 * 单选自动进入下一题；多选显示「下一题」；「算了 / 先跳过」与选项并列。
 * 提交入口经 onControl 交给 GalView 的输入框按钮。
 */
function QuestionCard({ wait, onControl }) {
  const questions = questionsOf(wait)
  const [flow, setFlow] = useState(() => ({ index: 0, states: emptyDrafts(questions) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // 作答框本地非受控(与官方对话栏同思路):React 不重写 value,IME/光标交给浏览器。
  const answerRef = useRef(null)
  const answerText = () => (answerRef.current !== null ? answerRef.current.value : '')
  const clearAnswer = () => {
    if (answerRef.current !== null) answerRef.current.value = ''
  }
  const index = flow.index
  const states = flow.states
  const question = questions[index]
  if (question === undefined || questions.length === 0) return null
  const hasOptions = Array.isArray(question.options) && question.options.length > 0
  const multi = question.multiSelect === true
  const notLast = index < questions.length - 1

  const setCurrent = (patch) => {
    setFlow(cur => ({
      ...cur,
      states: cur.states.map((s, i) => (i === cur.index ? { ...s, ...patch } : s)),
    }))
    setError(null)
  }

  /** 进入下一题：把输入框里的自定义回答固化为本题答案，并清空输入框。 */
  const advance = (nextIndex) => {
    const text = answerText()
    setFlow(cur => {
      const states = cur.states.map((s, i) => {
        if (i !== cur.index) return s
        return text.trim() !== '' ? { ...s, custom: text, skipped: false } : s
      })
      return { index: nextIndex, states }
    })
    clearAnswer()
    setError(null)
  }

  const choose = (label) => {
    const text = answerText()
    if (multi) {
      setFlow(cur => ({
        ...cur,
        states: cur.states.map((s, i) => (
          i === cur.index ? { ...s, selected: toggleSelected(s.selected, label), skipped: false } : s
        )),
      }))
      setError(null)
      return
    }
    // 单选：非末题快照草稿并自动进入下一题；末题直接提交（galgame 点击即答）。
    const nextStates = states.map((s, i) => (i === index ? { ...s, selected: [label], skipped: false } : s))
    if (notLast) {
      const withCustom = nextStates.map((s, i) => (i === index && text.trim() !== '' ? { ...s, custom: text } : s))
      setFlow({ index: index + 1, states: withCustom })
      clearAnswer()
      setError(null)
      return
    }
    setFlow({ index, states: nextStates })
    setError(null)
    if (text.trim() === '') respondWith(nextStates)
  }

  const skip = () => {
    setCurrent({ selected: [], custom: '', skipped: true })
    clearAnswer()
    if (notLast) advance(index + 1)
  }

  const next = () => {
    const answered = draftAnswered(states[index]) || answerText().trim() !== ''
    if (!answered) {
      setError('请先回答本题')
      return
    }
    advance(index + 1)
  }

  const respondWith = useCallback((finalStates) => {
    if (busy) return
    if (!draftsComplete(finalStates)) {
      setError('还有未回答的问题')
      return
    }
    setBusy(true)
    setError(null)
    respondQuestion(wait, buildAnswers(questions, finalStates)).then(assertAccepted, (cause) => {
      setBusy(false)
      setError(causeText(cause))
    })
  }, [busy, questions, wait])

  const submit = useCallback(() => {
    const text = answerText()
    const finalStates = text.trim() !== ''
      ? states.map((s, i) => (i === index ? { ...s, custom: text, skipped: false } : s))
      : states
    respondWith(finalStates)
    clearAnswer()
  }, [states, index, respondWith])

  const cancel = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    cancelQuestion(wait).then(assertAccepted, (cause) => {
      setBusy(false)
      setError(causeText(cause))
    })
  }

  // 提问进行时通知 GalView（隐藏底部输入行，作答全部发生在选项列表内）。
  useEffect(() => {
    if (typeof onControl === 'function') {
      onControl({ submit })
      return () => onControl(null)
    }
  }, [submit, onControl])

  return (
    <div className="gv-pending-question" role="dialog" aria-label="提问">
      <div className="gv-pending-head">
        <Corners />
        {typeof question.header === 'string' && question.header !== '' && (
          <span className="gv-pending-eyebrow">{question.header}</span>
        )}
        <div className="gv-pending-head-row">
          <span className="gv-pending-title">{question.question}</span>
          <span className="gv-pending-mode">{multi ? '多选' : '单选'}</span>
          <span className="gv-pending-pager">{index + 1} / {questions.length}</span>
        </div>
        {typeof question.detail === 'string' && question.detail.trim() !== '' && (
          <p className="gv-pending-detail">{question.detail}</p>
        )}
      </div>
      <Divider />
      <div className="gv-pending-options">
        {hasOptions && question.options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={'gv-pending-option is-choice' + (states[index].selected.includes(option.label) ? ' is-selected' : '')}
            disabled={busy}
            onClick={() => choose(option.label)}
          >
            {option.label}
          </button>
        ))}
        {multi && notLast && (
          <button type="button" className="gv-pending-option is-gold" disabled={busy} onClick={next}>下一题</button>
        )}
        {/* 输入 + 提交整合的组合选项框：左边文本输入，右边提交。 */}
        <div className="gv-pending-option gv-pending-answer">
          <textarea
            className="gv-pending-answer-input"
            rows={1}
            placeholder="或输入你的回答……"
            ref={answerRef}
            defaultValue=""
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button type="button" className="gv-pending-answer-submit" disabled={busy} onClick={submit}>提交</button>
        </div>
        {/* 多选末题的「确定」（=提交）；单选无需（点击即答）。 */}
        {multi && !notLast && (
          <button type="button" className="gv-pending-option is-gold" disabled={busy} onClick={submit}>确定</button>
        )}
        <button type="button" className="gv-pending-option" disabled={busy} onClick={skip}>先跳过</button>
        <button type="button" className="gv-pending-option" disabled={busy} onClick={cancel}>算了</button>
      </div>
      {error !== null && <p className="gv-pending-error">{error}</p>}
    </div>
  )
}

/** 面板整体：无外层包裹框；批准与提问各渲染第一个；背景轻虚化。 */
export function PendingPanel({ pending, onControl }) {
  const items = pendingItems(pending)
  if (items.length === 0) return null
  const approval = items.find(wait => wait.kind === 'approval') ?? null
  // 计划待审(plan-review)与提问同卡片渲染(问题+选项,answer 批次同通道)。
  const question = items.find(wait => wait.kind === 'question' || wait.kind === 'plan-review') ?? null
  return (
    <div className="gv-pending-layer" role="region" aria-label="等待你的决定">
      <div className="gv-pending-veil" aria-hidden="true" />
      <div className="gv-pending-stack">
        {approval !== null && <ApprovalCard key={approval.key} wait={approval} />}
        {question !== null && <QuestionCard key={question.key} wait={question} onControl={onControl} />}
      </div>
    </div>
  )
}
