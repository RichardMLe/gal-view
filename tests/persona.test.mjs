import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hashCode, clip, isHumanText, thinkingLine, toolLine, runningLine, writingLine,
  waitApprovalLine, waitQuestionLine, idleLine, taskOf,
  normalizePersona, PERSONA_DEFAULTS, PERSONA_POOL_KEYS,
} from '../.dsh-plugin/client/persona.mjs'

test('hashCode 稳定且非零分布', () => {
  assert.equal(hashCode('call-1'), hashCode('call-1'))
  assert.notEqual(hashCode('call-1'), hashCode('call-2'))
})

test('clip 压缩空白并截断', () => {
  assert.equal(clip('  a\n  b  ', 10), 'a b')
  assert.equal(clip('x'.repeat(100), 10), 'x'.repeat(10) + '…')
})

test('isHumanText 过滤代码/JSON/符号行', () => {
  assert.equal(isHumanText('先看看目录'), true)
  assert.equal(isHumanText('{"command": "pwsh"}'), false)
  assert.equal(isHumanText('call "pwsh" with command'), false)
  assert.equal(isHumanText('`echo hi`'), false)
  assert.equal(isHumanText('- item'), false)
  assert.equal(isHumanText(''), false)
  assert.equal(isHumanText('长'.repeat(41)), false)
})

test('thinkingLine：人话追加摘要、代码不露出', () => {
  assert.match(thinkingLine('先看看目录'), /先看看目录/)
  const code = thinkingLine('{"command": "pwsh"}')
  assert.doesNotMatch(code, /command|[{]|"/)
})

test('toolLine：同一 callId 稳定、任务进台词、不同调用多样', () => {
  const line = toolLine('列出文件', 'call-1')
  assert.match(line, /列出文件/)
  assert.equal(toolLine('列出文件', 'call-1'), line)
  const seen = new Set()
  for (let i = 0; i < 60; i++) seen.add(toolLine('任务' + i, 'call-' + i))
  assert.ok(seen.size >= 20, '60 次调用只有 ' + seen.size + ' 种台词')
})

test('toolLine 毒舌池可被命中（15% 档，大样本内两种风格都出现）', () => {
  const normalSet = new Set(PERSONA_DEFAULTS.pools.toolNormalPrefix)
  const wittySet = new Set(PERSONA_DEFAULTS.pools.toolWittyPrefix)
  let normal = 0
  let tsundere = 0
  for (let i = 0; i < 2000; i++) {
    const line = toolLine('任务', 'probe-' + i)
    const prefix = line.split('「')[0]
    if (wittySet.has(prefix)) tsundere += 1
    else if (normalSet.has(prefix)) normal += 1
  }
  assert.ok(normal > 1000, '憨憨台词占多数')
  assert.ok(tsundere > 100, '毒舌台词会出现（实际 ' + tsundere + ' 次）')
})

test('runningLine / writingLine / 等待池 / 兜底池输出非空', () => {
  assert.notEqual(runningLine('整理目录'), '')
  assert.match(writingLine('安装完成'), /安装完成/)
  assert.notEqual(waitApprovalLine('a:1'), '')
  assert.notEqual(waitQuestionLine('q:1'), '')
  assert.notEqual(idleLine('idle'), '')
})

test('taskOf：按 description/file_path/pattern 提取，绝不回显代码', () => {
  assert.equal(taskOf(JSON.stringify({ command: 'Get-ChildItem', description: '列出文件' }), 'pwsh'), '列出文件')
  assert.equal(taskOf(JSON.stringify({ file_path: 'C:/a/b/AGENTS.md' }), 'read'), '读取 AGENTS.md')
  assert.match(taskOf(JSON.stringify({ pattern: 'gal' }), 'grep'), /gal/)
  assert.equal(taskOf('{"command":"x"}', 'pwsh'), 'pwsh') // 无描述回退工具名
  assert.equal(taskOf('not json', 'pwsh'), 'pwsh')
})

test('第12轮：池子总量翻三倍（合计 216 条）', () => {
  const pools = PERSONA_DEFAULTS.pools
  const expected = {
    thinking: 24, toolNormalPrefix: 36, toolNormalSuffix: 24,
    toolWittyPrefix: 36, toolWittySuffix: 24, executing: 18,
    writing: 18, waitApproval: 12, waitQuestion: 12, idle: 12,
  }
  let total = 0
  for (const key of PERSONA_POOL_KEYS) {
    assert.equal(pools[key].length, expected[key], key + ' 池数量')
    total += pools[key].length
  }
  assert.equal(total, 216)
})

test('thinkingLine 种子取首行：流式增长不换语气词（摘要仍随末行演变）', () => {
  const start = thinkingLine('先看看目录下有什么文件\n再来决定下一步')
  const grown = thinkingLine('先看看目录下有什么文件\n再来决定下一步，顺便确认一下文件大小和修改时间')
  const flavorOf = text => text.split('—— ')[0]
  assert.equal(flavorOf(start), flavorOf(grown), '语气词前缀应稳定')
  assert.match(grown, /文件大小/, '摘要应随末行更新')
  assert.doesNotMatch(flavorOf(grown), /[{}"]/, '语气词不含代码痕迹')
})

test('normalizePersona：默认/非法/自定义池与毒舌率夹取', () => {
  const def = normalizePersona(null)
  assert.equal(def.enabled, true)
  assert.equal(def.witPercent, 15)
  assert.equal(def.pools.thinking.length, 24)
  const custom = normalizePersona({ witPercent: 99, enabled: false, pools: { thinking: ['专用台词', '   ', ''], toolNormalPrefix: ['A'] } })
  assert.equal(custom.witPercent, 30)
  assert.equal(custom.enabled, false)
  assert.deepEqual(custom.pools.thinking, ['专用台词'])
  assert.deepEqual(custom.pools.toolNormalPrefix, ['A'])
  assert.equal(custom.pools.executing.length, 18) // 未提供 → 默认池
})

test('配置毒舌率生效：100% 全毒舌、0% 全憨憨', () => {
  const normalSet = new Set(PERSONA_DEFAULTS.pools.toolNormalPrefix)
  const wittySet = new Set(PERSONA_DEFAULTS.pools.toolWittyPrefix)
  const witty = { witPercent: 100 }
  const calm = { witPercent: 0 }
  for (let i = 0; i < 200; i++) {
    const wittyPrefix = toolLine('任务', 'probe-' + i, witty).split('「')[0]
    assert.ok(wittySet.has(wittyPrefix), '100% 毒舌档出现憨憨前缀：' + wittyPrefix)
    const calmPrefix = toolLine('任务', 'probe-' + i, calm).split('「')[0]
    assert.ok(normalSet.has(calmPrefix), '0% 毒舌档出现毒舌前缀：' + calmPrefix)
  }
})
