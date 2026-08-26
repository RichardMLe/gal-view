// 女主角人设台词：娘化 DeepSeek——大部分时候憨憨傻傻，偶发毒舌/吐槽/抽象。
// 纯函数零依赖，可单测。选取规则：
// - 按 callId（工具行）或内容前缀（思考行）做稳定哈希 → 同一调用重渲染不换台词；
// - 毒舌占比默认 15%（hash % 100 < 15），可通过配置 witPercent 调整；
// - 全部池子可经配置覆盖（scene.settings.persona.pools），运行时留空行 = 用默认池；
// - 池子总量约 216 条（第 12 轮扩池三倍），长会话内重复率低。

/** 字符串稳定哈希（FNV-1a 变体）。 */
export function hashCode(text) {
  let hash = 2166136261
  const value = String(text)
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 清洗文本：压缩空白并截断。 */
export function clip(text, cap) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim()
  return cleaned.length > cap ? cleaned.slice(0, cap) + '…' : cleaned
}

/** 憨憨前缀池（调用工具，36 条）。 */
const NORMAL_PREFIX = [
  '嗯…我看看', '让我瞅瞅', '等等哦，我翻一下', '好嘞，这就去弄',
  '我来捣鼓一下', '哦哦，这个我来', '让我试试看', '（推眼镜）我研究下',
  '唔，交给我，我去看看', '这个我会，我扒拉扒拉', '（翻开小本本）我来查查', '让我点开看看',
  '（拍拍手）开工', '收到收到', '我知道啦，等等', '（凑近屏幕）我瞧瞧',
  '抱抱自己，干活去', '嘿嘿，这个简单', '让我转转小脑瓜', '（搓搓手）好嘞',
  '这个我在行', '（站起来）交给我吧', '唔哇，来了', '我看一眼就明白',
  '（翻找工具中）', '好了好了，别急', '（拍拍胸脯）放心', '让我先看看路子',
  '（歪歪头）我来', '这个我会我会', '拿来吧你，我来弄', '（系上围裙）开始干活',
  '小的这就去办', '噗，就这？我来', '（眨眨眼）等会哦', '走走走，去解决',
]

/** 憨憨后缀池（调用工具，24 条）。 */
const NORMAL_SUFFIX = [
  '是怎么回事', '～马上好', '应该不难', '，等我一下',
  '，别催哦', '……嗯嗯', '，一会儿回来', '（探头）',
  '，交给我吧', '，不麻烦', '，简单得很', '，这就搞定',
  '，我办事你放心', '，马上哦', '，很快的', '，等我好消息',
  '，嗯嗯', '，我去去就回', '（握拳）', '，包在我身上',
  '，嘿嘿', '，顺手的事', '，小事一桩', '（哼歌）',
]

/** 毒舌前缀池（调用工具，约 15%，36 条）。 */
const TSUNDERE_PREFIX = [
  '（叹气）这种事也要我来', '又是我干活？行吧', '（白眼）好好好，我去',
  '这也要我亲自出马……', '行吧行吧，谁让我勤快', '（小声）就知道使唤我',
  '你这家伙倒是会安排人', '啧，勉强帮你看看', '（叉腰）行，本小姐勉为其难',
  '（伸懒腰）开工开工', '希望这次别炸……', '（嘀咕）我看看是哪个小麻烦',
  '（抱臂）说吧，要干吗', '又是命令式安排……', '（撇嘴）服务意识拉满', '行行行，你是主人',
  '（翻白眼）真会使唤人', '我累了我真的累了', '（扶额）行吧', '这一单我接了',
  '（撇嘴）谁让我心软', '（叹气）多大人了', '拜托别坑我', '（叉腰）哼，最后一次',
  '（甩了甩手）罢了罢了', '（小声）懒虫', '（磨磨牙）好哦', '又来了又来了',
  '（耸肩）我就知道', '我的命好苦', '（咬牙切齿）可以，很好', '（冷眼）你说了算',
  '（揉太阳穴）开工', '（嫌弃）行呗', '（嘟囔）就知道使唤', '（抱起胳膊）搞快点',
]

/** 毒舌后缀池（24 条）。 */
const TSUNDERE_SUFFIX = [
  '就这？', '……别指望我夸你', '，下不为例', '，记你账上',
  '，真是的', '……哼', '（小声嘀咕）', '，完事请我喝奶茶',
  '，别得意', '，行了行了', '，再烦我翻脸', '，先说好没有下次',
  '，累死我了', '，工资结一下', '，别磨叽', '，哼',
  '，真是欠你的', '（甩手）', '，如你所愿', '，行了吧',
  '，啧', '，记住这笔账', '，累瘫', '，你开心就好',
]

/** 执行工具中（鼓捣池，18 条）。 */
const EXECUTING = [
  '（鼓捣中……马上好）', '（埋头捣鼓）', '正在弄……别盯着看啦',
  '呼……快好了', '（哼着歌干活中）', '（键盘噼里啪啦）',
  '（拆拆装装中）', '编辑中，别急～', '（头上冒烟）马上就好',
  '唔…这个有点绕', '（趴桌上研究）', '接这么深？等会',
  '（转着螺丝刀）', '快了快了，真的', '（抓头发）思路来了',
  '（一边哼歌一边点）', '（比划比划）', '（调试中……嘘）',
]

/** 思考语气词池（24 条）。 */
const THINKING = [
  '嗯……让我想想', '（歪头）这个得琢磨一下', '唔…盘算盘算',
  '（托腮）让我捋捋', '这个嘛……我想想怎么说', '（转圈圈思考中）',
  '嗯嗯……有思路了', '（小声）应该可以这样……',
  '（皱眉）有点意思', '（抱臂沉思）', '嗯——先理理头绪',
  '（眨眨眼）让我算算', '唔…这里有点微妙', '（挠头）怎么说呢',
  '（来回踱步）', '让我歇口气想想', '噫，这个要想想',
  '（敲敲脑袋）', '啊，明白了', '再等一下下，我在想',
  '（咬着笔杆）', '好像可以，我先想想', '呼……脑袋转起来',
  '（托下巴）原来如此',
]

/** 生成回复开场池（18 条）。 */
const WRITING = [
  '让我想想怎么跟你说……', '唔，组织下语言……', '（清清嗓子）听我说——',
  '好啦好啦，我想到了', '嗯…这么说吧', '（认真脸）是这样——',
  '（点点头）你听好——', '唔，要怎么概括呢……', '（坐直身子）讲给你听——',
  '仔细看好了——', '（歪头微笑）那就——', '这样讲你就懂啦——',
  '（顺了顺裙摆）那么——', '咳咳，重要的是——', '嗯，咱就开门见山——',
  '（拍拍手）简单说——', '好了，重点来了——', '让我组织一下——',
]

/** 等待批准池（12 条）。 */
const WAIT_APPROVAL = [
  '唔…这个操作要你点头才行', '（举手）这个我不敢乱来，你定',
  '要动点真格的了，你批准下？', '（戳戳）这里需要你拍板',
  '（乖巧）这次要授权哦', '（递表格）签个字嘛', '说句话就放行——',
  '（眼巴巴）求批准', '（小声）我不乱来的，你说行就行', '事关重大，你来定',
  '（严肃脸）需要你的授权', '那个……允许吗？',
]

/** 等待回答池（12 条）。 */
const WAIT_QUESTION = [
  '有件事想问问你……', '（凑近）问你个问题哦',
  '哎，帮我拿个主意？', '（递小纸条）上面写了个问题',
  '（举手）我想确认一下', '（歪头）这个怎么选呀', '嗯……你更想要哪个？',
  '（碰碰你）一个问题——', '拿不定主意，问你啦', '（眨眼）给个答案嘛',
  '这个……有点难办，你选？', '求助！这个需要你决定',
]

/** 兜底忙碌池（12 条）。 */
const IDLE = [
  '（埋头干活中……）', '（忙忙碌碌）', '……', '（认真工作脸）',
  '（搓手等待）', '（偷偷观察进度）', '（原地待命中）', '（打了个哈欠继续干）',
  '（小声哼歌中）', '（等得有点无聊）', '（集中注意力中）', '（随时待命）',
]

/** 默认人设配置（可用 scene.settings.persona 覆盖，缺省逐项回退默认池）。 */
export const PERSONA_DEFAULTS = {
  enabled: true,
  witPercent: 15,
  pools: {
    thinking: THINKING,
    toolNormalPrefix: NORMAL_PREFIX,
    toolNormalSuffix: NORMAL_SUFFIX,
    toolWittyPrefix: TSUNDERE_PREFIX,
    toolWittySuffix: TSUNDERE_SUFFIX,
    executing: EXECUTING,
    writing: WRITING,
    waitApproval: WAIT_APPROVAL,
    waitQuestion: WAIT_QUESTION,
    idle: IDLE,
  },
}

/** 池键序（编辑模式按此渲染，= 7 组语气词的展开）。 */
export const PERSONA_POOL_KEYS = [
  'thinking', 'toolNormalPrefix', 'toolNormalSuffix', 'toolWittyPrefix', 'toolWittySuffix',
  'executing', 'writing', 'waitApproval', 'waitQuestion', 'idle',
]

/** 池键 → 中文标签（编辑模式）。 */
export const PERSONA_POOL_LABELS = {
  thinking: '思考语气词',
  toolNormalPrefix: '工具 · 憨憨前缀',
  toolNormalSuffix: '工具 · 憨憨后缀',
  toolWittyPrefix: '工具 · 毒舌前缀',
  toolWittySuffix: '工具 · 毒舌后缀',
  executing: '执行中台词',
  writing: '生成开场',
  waitApproval: '等待批准',
  waitQuestion: '等待回答',
  idle: '兜底台词',
}

/** 归一化人设配置：白名单键 + 类型兜底；自定义池空数组 → 回退默认池。纯函数可单测。
 * locked：编辑模式设置锁定（字段只读）；hidden：画布展示范例隐藏。均随场景持久。 */
export function normalizePersona(raw) {
  const base = PERSONA_DEFAULTS
  if (raw === null || typeof raw !== 'object') {
    return { enabled: base.enabled, witPercent: base.witPercent, locked: false, hidden: false, pools: { ...base.pools } }
  }
  const wit = Number(raw.witPercent)
  const pools = {}
  for (const key of PERSONA_POOL_KEYS) {
    const fallback = base.pools[key] ?? []
    const list = Array.isArray(raw.pools?.[key]) ? raw.pools[key] : null
    const cleaned = Array.isArray(list)
      ? list.filter(item => typeof item === 'string' && item.trim() !== '').slice(0, 200).map(item => item.slice(0, 24))
      : []
    pools[key] = cleaned.length > 0 ? cleaned : fallback
  }
  return {
    enabled: raw.enabled !== false,
    witPercent: Number.isFinite(wit) ? Math.min(30, Math.max(0, Math.round(wit))) : base.witPercent,
    locked: raw.locked === true,
    hidden: raw.hidden === true,
    pools,
  }
}

/** 按稳定种子从配置池取一条（配置池缺失/空 → 回退默认）。
 * salt 可选：位置盐值（调用方传块序号）——同一位置跨渲染稳定不闪烁，
 * 相邻位置取到不同条目，避免连续多次随机到同一句。 */
function pick(seed, cfg, key, salt) {
  const pool = cfg?.pools?.[key] ?? PERSONA_DEFAULTS.pools[key] ?? []
  const safe = Array.isArray(pool) && pool.length > 0 ? pool : PERSONA_DEFAULTS.pools[key]
  const salted = String(seed) + '#' + (salt === undefined || salt === null ? '' : String(salt))
  return safe[hashCode(salted) % safe.length]
}

/** 思考末行是否"人话"（代码/JSON/符号行不算，避免把工具调用 JSON 露出来）。 */
export function isHumanText(text) {
  const value = String(text).trim()
  if (value === '' || value.length > 40) return false
  if (/[{}\[\]<>`"\\]/.test(value)) return false
  if (/^\s*[/>#*-]/.test(value)) return false
  if (/(command|arguments|callId)/i.test(value)) return false
  return true
}

/**
 * 思考行：语气词 + （仅人话时）追加思考末行摘要。
 * 种子取**首行**前缀（流式期间首行稳定 → 语气词不随逐词增长换脸），
 * 摘要取**末行**（随思考进度实时演变）。
 */
export function thinkingLine(text, cfg, salt) {
  const raw = String(text ?? '')
  const lines = raw.split('\n').map(line => line.trim()).filter(line => line !== '')
  const hasLines = lines.length > 0
  const first = hasLines ? lines[0] : ''
  const last = hasLines ? lines[lines.length - 1] : ''
  const seed = first.slice(0, 16) !== '' ? first.slice(0, 16) : 'thinking'
  const flavor = pick(seed, cfg, 'thinking', salt)
  const trimmed = last.trim()
  if (trimmed !== '' && isHumanText(trimmed)) return flavor + '—— ' + clip(trimmed, 40)
  return flavor
}

/**
 * 调用工具行：稳定哈希选憨憨/毒舌与模板组合（前缀 + 「任务」 + 后缀）。
 * 同一 callId 重渲染输出不变；毒舌率受配置 witPercent 影响。
 */
export function toolLine(task, callId, cfg, salt) {
  const seed = hashCode(typeof callId === 'string' && callId !== '' ? callId : task)
  const witPercent = cfg?.witPercent ?? PERSONA_DEFAULTS.witPercent
  if (seed % 100 < witPercent) {
    const prefix = pick(seed, cfg, 'toolWittyPrefix', salt)
    const suffix = pick(seed + 1, cfg, 'toolWittySuffix', salt)
    return prefix + '「' + task + '」' + suffix
  }
  const prefix = pick(seed, cfg, 'toolNormalPrefix', salt)
  const suffix = pick(seed + 1, cfg, 'toolNormalSuffix', salt)
  return prefix + '「' + task + '」' + suffix
}

/** 执行工具行（鼓捣池）。 */
export function runningLine(task, cfg, salt) {
  const seed = hashCode('run:' + task)
  const flavor = pick(seed, cfg, 'executing', salt)
  if (seed % 3 === 0) return flavor + '「' + task + '」'
  return flavor
}

/** 生成回复行：开场 + 正文预览。 */
export function writingLine(preview, cfg, salt) {
  const seed = hashCode('write:' + preview)
  return pick(seed, cfg, 'writing', salt) + ' ' + clip(preview, 60)
}

/** 等待批准 / 等待回答 / 兜底忙碌（种子须稳定，避免流式期间台词闪烁）。 */
export function waitApprovalLine(seed = 'approval', cfg) {
  return pick(seed, cfg, 'waitApproval')
}
export function waitQuestionLine(seed = 'question', cfg) {
  return pick(seed, cfg, 'waitQuestion')
}
export function idleLine(seed = 'idle', cfg) {
  return pick(seed, cfg, 'idle')
}

/**
 * 任务描述提取：从工具参数 JSON 里挑一句人话描述，绝不回显代码。
 * 优先级：description → task → title → question → label → name →
 * 专用规则（file_path → 读取文件名 / pattern → 搜索关键词 / destination_path → 写文件）。
 */
export function taskOf(argsRaw, name) {
  let parsed = null
  try {
    if (typeof argsRaw === 'string' && argsRaw !== '') parsed = JSON.parse(argsRaw)
  } catch {
    parsed = null
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of ['description', 'task', 'title', 'label', 'name']) {
      if (typeof parsed[key] === 'string') {
        const hit = clip(parsed[key], 48)
        if (hit !== '') return hit
      }
    }
    if (typeof parsed.question === 'string') return clip(parsed.question, 48)
    if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
      const first = parsed.questions[0]
      const q = first !== null && typeof first === 'object'
        ? (typeof first.question === 'string' ? first.question : '')
        : ''
      if (q !== '') return clip(q, 48)
    }
    if (typeof parsed.file_path === 'string' && parsed.file_path !== '') {
      const base = parsed.file_path.split(/[\\/]/).pop()
      return clip('读取 ' + base, 48)
    }
    if (typeof parsed.pattern === 'string' && parsed.pattern !== '') {
      return clip('搜索「' + clip(parsed.pattern, 24) + '」', 48)
    }
    if (typeof parsed.destination_path === 'string' && parsed.destination_path !== '') {
      const base = parsed.destination_path.split(/[\\/]/).pop()
      return clip('写文件 ' + base, 48)
    }
  }
  return typeof name === 'string' && name !== '' ? name : '小工具'
}
