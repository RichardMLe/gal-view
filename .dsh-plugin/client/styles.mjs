/** GAL 视窗样式：全部作用域限定在 [data-gal-view] 之下，避免污染宿主。
 * 视觉基调：深色夜晚 + 半透明毛玻璃 + 紫蓝/靛青/暗红点缀 + 细边框 + 克制的发光。
 */

import { GV_BOW_ART, GV_SETTINGS_FRAME_ART, GV_SIDEBAR_CORNER_ART } from './skinart.mjs'

export const CSS = `
[data-gal-view] {
  --gv-bg: #0a0d1c;
  --gv-panel: rgba(16, 20, 38, .86);
  --gv-panel-2: rgba(24, 29, 52, .94);
  --gv-line: rgba(255, 255, 255, .09);
  --gv-line-strong: rgba(255, 255, 255, .17);
  --gv-text: #e6e9f4;
  --gv-text-dim: #98a1c2;
  --gv-accent: #8f7bff;
  --gv-accent-2: #4f8cff;
  --gv-accent-red: #e05a6b;
  --gv-glow: 0 0 0 1px rgba(143, 123, 255, .30), 0 0 16px rgba(143, 123, 255, .16);
  box-sizing: border-box;
  position: relative;
  z-index: 0; /* 自身成层叠上下文：-1 层模糊延展背景可垫底，内容按文档序上浮 */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 60vh;
  overflow: hidden;
  background:
    radial-gradient(1200px 500px at 18% -10%, rgba(79, 140, 255, .07), transparent 60%),
    radial-gradient(900px 420px at 85% 110%, rgba(143, 123, 255, .08), transparent 60%),
    var(--gv-bg);
  color: var(--gv-text);
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  user-select: none;
}
[data-gal-view] *, [data-gal-view] *::before, [data-gal-view] *::after { box-sizing: border-box; }
[data-gal-view] input, [data-gal-view] textarea, [data-gal-view] select { user-select: text; }

/* ---------- 填满会话区 ---------- */
/* 挂载时组件隐藏会话外壳的输入席并给根节点打上该标记：绝对定位占满整个会话主体。
 * 右侧补偿：外壳预留滚动条槽（scrollbar-gutter: stable）会让视窗右缘露出一道缝隙，
 * 用官方同一变量把右缘扩展到槽里（变量未定义时 0，无副作用）。 */
[data-gal-view][data-gal-fills] {
  position: absolute;
  inset: 0;
  right: calc(0px - var(--dsh-scrollbar-width, 0px));
  height: auto;
  min-height: 0;
  z-index: 5;
}

/* 外壳隐藏规则改用 CSS（:has + !important）而非组件内联样式：
 * 官方容器因批准/问答接管而重挂载时，内联样式会丢失 → 输入席闪现再隐藏 → 整窗闪烁。
 * CSS 规则挂在 [data-gal-fills] 标记上，标记由组件卸载时移除，随取随弃。 */
[data-conversation-scroll]:has([data-gal-view][data-gal-fills]) {
  overflow: hidden !important;
  position: relative !important;
}
[data-conversation-scroll]:has([data-gal-view][data-gal-fills]) > [data-composer-seat] {
  display: none !important;
}
/* 官方批准/提问卡片（含红感叹号等图标）禁止在 GAL 视窗的会话区内闪现：
 * 决策全部由 gal-view 自己的面板承载，官方卡片一出现即隐藏。 */
[data-conversation-scroll]:has([data-gal-view][data-gal-fills]) :is([data-approval-key], [data-plan-review-key], [data-question-key]) {
  display: none !important;
}
/* 官方队列停靠栏（data-queue-dock）：批准落定时重渲染、错误态图标（红感叹号）
 * 瞬时闪现——GAL 视窗激活期间整体隐藏（队列操作在官方「对话」栏进行）。 */
[data-conversation-scroll]:has([data-gal-view][data-gal-fills]) [data-queue-dock] {
  display: none !important;
}

/* 背景铺满：游戏模式舞台 cover 适配（铺满整个视窗，边缘裁剪），
 * 编辑模式舞台 contain 适配（WYSIWYG）。不再使用模糊延展层。 */

/* ---------- 顶部栏 ---------- */
.gv-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--gv-line);
  background: linear-gradient(180deg, rgba(20, 24, 44, .7), rgba(14, 17, 34, .35));
}
.gv-brand { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; letter-spacing: .12em; color: var(--gv-text); }
.gv-brand-mark {
  width: 10px; height: 10px; transform: rotate(45deg);
  background: linear-gradient(135deg, var(--gv-accent), var(--gv-accent-2));
  box-shadow: 0 0 10px rgba(143, 123, 255, .55);
}
.gv-mode-switch { display: flex; border: 1px solid var(--gv-line-strong); }
.gv-mode-btn {
  border: 0; background: transparent; color: var(--gv-text-dim);
  padding: 4px 16px; font-size: 12px; cursor: pointer;
  transition: color .15s ease, background .15s ease;
}
.gv-mode-btn + .gv-mode-btn { border-left: 1px solid var(--gv-line-strong); }
.gv-mode-btn:hover { color: var(--gv-text); background: rgba(255, 255, 255, .04); }
.gv-mode-btn.is-on { color: #fff; background: linear-gradient(180deg, rgba(143, 123, 255, .22), rgba(79, 140, 255, .14)); box-shadow: inset 0 -2px 0 var(--gv-accent); }
.gv-topbar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.gv-topbar-hint { font-size: 11px; color: var(--gv-text-dim); letter-spacing: .05em; }

/* ---------- 按钮 ---------- */
.gv-btn {
  border: 1px solid var(--gv-line-strong);
  background: rgba(255, 255, 255, .03);
  color: var(--gv-text);
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 3px;
  cursor: pointer;
  transition: border-color .15s ease, background .15s ease, box-shadow .15s ease, color .15s ease;
}
.gv-btn:hover:not(:disabled) {
  border-color: rgba(143, 123, 255, .65);
  background: rgba(143, 123, 255, .10);
  box-shadow: 0 0 12px rgba(143, 123, 255, .22);
  color: #fff;
}
.gv-btn:disabled { opacity: .38; cursor: not-allowed; }
.gv-btn-accent {
  border-color: rgba(143, 123, 255, .55);
  background: linear-gradient(180deg, rgba(143, 123, 255, .20), rgba(79, 140, 255, .12));
}
.gv-btn-accent:hover:not(:disabled) { background: linear-gradient(180deg, rgba(143, 123, 255, .30), rgba(79, 140, 255, .18)); }
/* 金色主按钮：决策面板「允许一次/提交」——金边 + 鲸鱼蓝内里。 */
.gv-btn-gold {
  border-color: rgba(197, 164, 104, .7);
  background: linear-gradient(180deg, rgba(32, 49, 112, .92), rgba(24, 38, 88, .92));
  color: #eef1fb;
}
.gv-btn-gold:hover:not(:disabled) {
  border-color: #e2cfaa;
  background: linear-gradient(180deg, rgba(44, 64, 138, .95), rgba(30, 46, 104, .95));
  box-shadow: 0 0 12px rgba(197, 164, 104, .32);
  color: #fff;
}
.gv-toggle.is-on {
  border-color: rgba(143, 123, 255, .7);
  background: rgba(143, 123, 255, .14);
  color: #fff;
  box-shadow: 0 0 10px rgba(143, 123, 255, .2);
}

/* ---------- 舞台 ---------- */
.gv-stage-area { flex: 1 1 auto; min-height: 0; display: flex; }
.gv-stage-wrap {
  flex: 1 1 auto; min-width: 0; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; position: relative;
  /* 不再使用实色底：模糊延展背景经根节点垫底后从这里透出；仅留轻暗角聚焦舞台。 */
  background: radial-gradient(900px 460px at 50% 30%, rgba(8, 10, 24, .34), transparent 70%);
}
.gv-stage {
  position: relative;
  flex: none;
  /* 居中缩放：wrap 按未缩放的布局盒居中，原点取中心才能让缩放后的舞台视觉居中（0 0 会在小窗口把舞台挤到左上并被裁掉）。 */
  transform-origin: 50% 50%;
  /* 常驻合成层：缩放落定后按目标尺寸栅格化，避免缩放瞬时/缩放后残留模糊。
     transform 过渡：外部布局突变（批准框等）引发缩放跳变时平滑过渡，不再闪一下。 */
  will-change: transform;
  transition: transform .16s ease-out;
  background: #0c1026;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .06), 0 22px 60px rgba(0, 0, 0, .55);
}
.gv-grid {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background-image:
    linear-gradient(rgba(143, 123, 255, .10) 1px, transparent 1px),
    linear-gradient(90deg, rgba(143, 123, 255, .10) 1px, transparent 1px);
}
/* 边缘吸附指引线（手势期间显示）。 */
.gv-guide {
  position: absolute; z-index: 9998; pointer-events: none;
  background: var(--gv-accent-2);
  box-shadow: 0 0 6px rgba(79, 140, 255, .85);
}
.gv-guide-x { top: 0; bottom: 0; width: 1px; }
.gv-guide-y { left: 0; right: 0; height: 1px; }

/* ---------- 元素 ---------- */
.gv-el { position: absolute; border-style: solid; pointer-events: none; overflow: visible; }
.gv-stage.is-editor .gv-el.is-pickable { pointer-events: auto; cursor: move; }
/* 透明功能按钮：游戏模式可点击（元素级交互，无悬停高亮）。 */
[data-gal-mode='game'] :is(.gv-el-action-button, .gv-el-button) { pointer-events: auto; cursor: pointer; }
.gv-el-action-button.is-on { border-color: var(--gv-accent); background: rgba(143, 123, 255, .14); color: #fff; }
.gv-stage.is-editor .gv-el.is-pickable:hover { outline: 1px solid rgba(143, 123, 255, .55); outline-offset: 1px; }
.gv-el.is-locked { cursor: not-allowed; }

/* 背景占位 */
.gv-elbg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: inherit; overflow: hidden; }
.gv-elbg-label {
  font-size: inherit; letter-spacing: .5em; text-indent: .5em; opacity: .4; color: inherit;
  text-shadow: 0 1px 12px rgba(0, 0, 0, .5);
}
.gv-elbg-corners {
  position: absolute; inset: 10px; border: 1px solid rgba(255, 255, 255, .07);
}
.gv-elbg-corners::before, .gv-elbg-corners::after {
  content: ''; position: absolute; width: 18px; height: 18px;
}
.gv-elbg-corners::before { top: -1px; left: -1px; border-top: 2px solid rgba(255, 255, 255, .22); border-left: 2px solid rgba(255, 255, 255, .22); }
.gv-elbg-corners::after { bottom: -1px; right: -1px; border-bottom: 2px solid rgba(255, 255, 255, .22); border-right: 2px solid rgba(255, 255, 255, .22); }

/* 角色占位立绘 */
.gv-char { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; }
.gv-el-character .gv-char { animation: gv-float 4.6s ease-in-out infinite; }
.gv-char-svg { width: 100%; height: calc(100% - 30px); filter: drop-shadow(0 10px 22px rgba(0, 0, 0, .5)); }
/* 真实立绘：底部对齐、等比缩放（保持透明 PNG 的轮廓与站位一致）。 */
.gv-char-img { width: 100%; height: calc(100% - 30px); object-fit: contain; object-position: bottom center; filter: drop-shadow(0 10px 22px rgba(0, 0, 0, .5)); }
.gv-char.is-speaking .gv-char-svg {
  filter: drop-shadow(0 0 10px currentColor) drop-shadow(0 10px 22px rgba(0, 0, 0, .5));
  color: var(--gv-speak-color, #9b8cff);
}
.gv-char-plate {
  margin-top: 6px; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 3px 12px;
  background: rgba(12, 15, 30, .78);
  border: 1px solid var(--gv-line-strong);
  border-radius: 2px;
}
.gv-char-label { font-size: 10px; letter-spacing: .28em; color: var(--gv-text-dim); }
.gv-char-name { font-size: 12px; font-weight: 600; }

/* 编辑器里的对话框静态样式 */
.gv-elbox { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 14px 18px 12px 30px; overflow: hidden; }
.gv-elbox-name {
  position: absolute; top: -18px; left: 8px;
  padding: 1px 14px; font-size: 13px; font-weight: 600; letter-spacing: .1em;
  background: rgba(14, 17, 34, .92); border-left: 3px solid currentColor;
}
.gv-elbox-text { font-size: inherit; line-height: 1.7; color: inherit; margin-top: auto; }

/* 文本/形状/按钮/装饰 */
.gv-eltext { position: absolute; inset: 0; display: flex; align-items: center; justify-content: inherit; padding: 6px; overflow: hidden; word-break: break-word; }
.gv-elbtn { position: absolute; inset: 0; display: flex; align-items: center; justify-content: inherit; overflow: hidden; letter-spacing: .12em; }
.gv-elshape { position: absolute; inset: 0; display: flex; align-items: center; justify-content: inherit; overflow: hidden; letter-spacing: .18em; }
.gv-eldeco {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: inherit; overflow: hidden;
  background-image: repeating-linear-gradient(45deg, transparent 0 7px, rgba(255, 255, 255, .05) 7px 8px);
  border-style: dashed !important;
}
.gv-eldeco-label { font-size: inherit; letter-spacing: .22em; color: inherit; opacity: .85; }

/* ---------- 游戏对话框 ----------
 * 不启用 backdrop-filter：毛玻璃会把背后立绘 PNG 的透明区域复合成实心模糊块，
 * 破坏「透明度 → 看到清晰立绘」的预期。透明只走标准 alpha 混合（元素 opacity + 半透明背景）。 */
.gv-dialogue {
  position: absolute; pointer-events: auto; cursor: pointer;
  border-style: solid;
  transition: box-shadow .2s ease, border-color .2s ease;
}
/* 游戏模式对话区不渲染任何悬停/聚焦高亮（点击跳过打字无需视觉反馈边框）。 */
.gv-dialogue:focus, .gv-dtext:focus { outline: none; }
/* 独立「说话人」元素：文本框类型（默认纯文本外观，可自行加背景/边框），
 * 游戏模式动态显示当前台词行的说话人（你/DeepSeek/隐藏）。 */
.gv-sname {
  position: absolute; border-style: solid;
  display: flex; align-items: center; justify-content: inherit; overflow: hidden;
  padding: 2px 6px; white-space: nowrap;
  letter-spacing: .14em; font-weight: 700;
}
.gv-el > .gv-sname { inset: 0; }
.gv-dialogue-body {
  position: absolute; inset: 10px 18px 8px 18px;
  overflow-y: auto; scrollbar-width: thin;
  font-size: inherit; line-height: 1.8; letter-spacing: .02em;
  white-space: pre-wrap; word-break: break-word; color: inherit;
}
.gv-dialogue-caret {
  display: inline-block; width: 2px; height: 1.05em; margin-left: 3px;
  background: var(--gv-accent-2); vertical-align: text-bottom;
  animation: gv-blink 1s steps(2, start) infinite;
}
/* 独立「台词」元素：实时对话文本渲染进它，位置/尺寸/字号/颜色随元素属性。
 * 完全透明（无背景/无悬停描边/无滚动条视觉），避免边缘黑框。 */
.gv-dtext {
  position: absolute; pointer-events: auto; cursor: pointer;
  overflow: hidden; scrollbar-width: none;
  padding: 2px 10px;
  line-height: 1.8; letter-spacing: .02em;
  white-space: pre-wrap; word-break: break-word;
  border-style: solid;
}
.gv-dtext::-webkit-scrollbar { display: none; }
/* 页尾省略号：紧贴文本（负边距抵消 letter-spacing 间隙）。 */
.gv-dtext-ellipsis {
  letter-spacing: 0;
  margin-left: -0.02em;
  opacity: .85;
}
/* Galgame 翻页提示（还有下一页时显示在文本框右下角）。 */
.gv-dtext-more {
  position: absolute; right: 8px; bottom: 2px;
  font-size: .7em; color: var(--gv-accent);
  animation: gv-pulse 1.4s ease-in-out infinite;
}
/* AI 状态行（思考中…/编写代码中…）：与对话文本同字号、次级色、轻微呼吸。 */
.gv-dtext-status {
  color: var(--gv-text-dim);
  letter-spacing: .04em;
  animation: gv-pulse 1.6s ease-in-out infinite;
}

/* ---------- 输入 ----------
 * 游戏模式底部仅剩输入区（84px，固定高度）；控制功能已迁入场景内「透明按钮」元素。
 * 编辑模式用「工具栏 40px + 占位条 44px」对齐这里的 84px，
 * 保证两种模式的舞台槽位尺寸严格一致 → WYSIWYG。 */
.gv-input { flex: none; height: 84px; display: flex; gap: 10px; align-items: stretch; padding: 8px 16px 10px; }
/* 提问期间隐藏输入行（不卸载）：布局零变化，决策面板出现/消失不再引发舞台缩放/闪烁。 */
.gv-input.is-hidden { visibility: hidden; pointer-events: none; }

/* ---------- 上下文占用指示条 ----------
 * 覆盖层：absolute 下移 12px，贴于背景下缘与输入框之间；
 * 不占布局（舞台区大小不变）；整条 pointer-events:none —— 不挡输入框点击。 */
.gv-stage-area { position: relative; }
.gv-context {
  position: absolute; left: 0; right: 0; bottom: -12px;
  display: flex; align-items: center; gap: 10px;
  height: 12px; padding: 0 16px;
  pointer-events: none;
}
.gv-context-track {
  position: relative; flex: 1 1 auto; min-width: 0;
  height: 4px; border-radius: 2px;
  background: rgba(255, 255, 255, .14);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08);
}
.gv-context-fill {
  position: absolute; inset: 0 auto 0 0;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(79, 140, 255, .75), rgba(143, 123, 255, .85));
  box-shadow: 0 0 8px rgba(143, 123, 255, .35);
  transition: width .3s ease;
}
.gv-context-fill.is-high {
  background: linear-gradient(90deg, rgba(190, 145, 75, .8), rgba(224, 90, 107, .85));
  box-shadow: 0 0 8px rgba(224, 90, 107, .4);
}
.gv-context-whale {
  position: absolute; top: 50%;
  transform: translate(-50%, -50%);
  font-size: 15px; line-height: 1;
  filter: drop-shadow(0 1px 2px rgba(2, 8, 28, .6));
  transition: left .3s ease;
  pointer-events: none;
}
.gv-context-num {
  flex: none; min-width: 36px; text-align: right;
  font-size: 11px; color: var(--gv-text-dim); font-variant-numeric: tabular-nums;
  letter-spacing: .04em;
}
.gv-input-box {
  flex: 1 1 auto; resize: none;
  background: rgba(10, 13, 28, .72);
  border: 1px solid var(--gv-line-strong);
  border-radius: 4px;
  color: var(--gv-text);
  font-family: inherit; font-size: 14px; line-height: 1.6;
  padding: 8px 12px;
  outline: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.gv-input-box:focus { border-color: rgba(143, 123, 255, .6); box-shadow: 0 0 0 1px rgba(143, 123, 255, .25), 0 0 16px rgba(143, 123, 255, .12); }
.gv-input-box::placeholder { color: var(--gv-text-dim); }
.gv-send { align-self: stretch; min-width: 84px; }

/* ---------- 历史面板 ---------- */
.gv-history {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 80;
  width: min(400px, 92%);
  display: flex; flex-direction: column;
  background: rgba(13, 16, 32, .94);
  border-left: 1px solid rgba(143, 123, 255, .3);
  box-shadow: -18px 0 44px rgba(0, 0, 0, .5);
  backdrop-filter: blur(10px);
  animation: gv-slide-in .24s cubic-bezier(.16, 1, .3, 1);
}
.gv-history-head {
  flex: none; display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--gv-line-strong);
  font-size: 13px; font-weight: 600; letter-spacing: .2em;
}
.gv-history-list { flex: 1; overflow-y: auto; padding: 6px 14px 14px; }
.gv-history-row { padding: 9px 0; border-bottom: 1px solid var(--gv-line); }
.gv-history-name { font-size: 12px; font-weight: 700; letter-spacing: .1em; }
.gv-history-text { margin: 3px 0 0; font-size: 13px; line-height: 1.7; color: var(--gv-text); white-space: pre-wrap; word-break: break-word; }
.gv-history-empty { padding: 24px 0; text-align: center; color: var(--gv-text-dim); font-size: 13px; }

/* ---------- 设置浮层 ---------- */
.gv-settings {
  position: absolute; right: 16px; bottom: 92px; z-index: 80;
  width: 300px;
  background: var(--gv-panel-2);
  border: 1px solid var(--gv-line-strong);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .5), var(--gv-glow);
  backdrop-filter: blur(10px);
  padding: 12px 14px;
  animation: gv-rise .18s cubic-bezier(.16, 1, .3, 1);
}
.gv-settings-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 8px; margin-bottom: 6px;
  border-bottom: 1px solid var(--gv-line-strong);
  font-size: 13px; font-weight: 600; letter-spacing: .2em;
}
.gv-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 12px; color: var(--gv-text-dim); }
.gv-settings-row input[type="text"], .gv-settings-row select {
  width: 170px;
  background: rgba(10, 13, 28, .7);
  border: 1px solid var(--gv-line-strong);
  color: var(--gv-text);
  font-size: 12px; padding: 3px 8px; border-radius: 3px; outline: none;
}
.gv-settings-row input:focus, .gv-settings-row select:focus { border-color: rgba(143, 123, 255, .6); }
.gv-settings-hint { margin: 8px 0 0; font-size: 11px; color: var(--gv-text-dim); line-height: 1.6; }
/* 选项框设置预览：渲染在编辑画布中央（= 游戏模式决策面板实际出现位置）的覆盖层；
 * 复用真实决策面板样式（字号由 CSS 变量驱动），pointer-events:none 不干扰编辑手势。 */
.gv-options-preview-stage {
  position: absolute; inset: 0; z-index: 6;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 24px;
  pointer-events: none;
}
.gv-options-preview-stage .gv-pending-head { width: min(420px, 90%); }
.gv-options-preview-stage .gv-pending-options { width: min(420px, 82%); margin-top: 0; }
/* 人设展示范例：常驻编辑画布右下角（活动行实际出现区域）的两行台词演示。 */
.gv-persona-preview {
  position: absolute; right: 18px; bottom: 14px; z-index: 6;
  display: flex; flex-direction: column; align-items: flex-end; gap: 3px;
  max-width: 46%;
  padding: 8px 12px;
  background: rgba(10, 13, 28, .72);
  border: 1px solid var(--gv-line-strong);
  border-radius: 4px;
  pointer-events: none;
}
.gv-persona-preview-line {
  font-size: 13px; line-height: 1.6; color: var(--gv-text);
  white-space: pre-wrap; word-break: break-word;
}
.gv-persona-preview-line.gv-activity-tool { color: var(--gv-text-dim); }

/* ---------- 存档/读档面板（分叉会话式） ----------
 * SAve = 创建会话分叉（xx-saveN），LOAD = 切换到分叉会话；
 * 居中浮层，行为与设置/历史面板一致（Escape 关闭）。 */
.gv-saves-layer {
  position: absolute; inset: 0; z-index: 90;
  display: flex; align-items: center; justify-content: center;
  background: rgba(5, 8, 18, .28);
}
.gv-saves {
  width: min(440px, 94%);
  max-height: 82%;
  display: flex; flex-direction: column;
  background: var(--gv-panel-2);
  border: 1px solid var(--gv-line-strong);
  border-radius: 6px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, .5), var(--gv-glow);
  padding: 12px 14px;
  animation: gv-rise .18s cubic-bezier(.16, 1, .3, 1);
}
.gv-saves-head {
  display: flex; align-items: center; justify-content: space-between;
  padding-bottom: 8px; margin-bottom: 6px;
  border-bottom: 1px solid var(--gv-line-strong);
  font-size: 13px; font-weight: 600; letter-spacing: .2em;
}
.gv-saves-hint { margin: 2px 0 0; font-size: 11px; line-height: 1.7; color: var(--gv-text-dim); }
.gv-saves-meta { margin: 4px 0 0; font-size: 11px; color: var(--gv-text-dim); letter-spacing: .04em; }
.gv-saves-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  margin-top: 8px;
  display: flex; flex-direction: column; gap: 6px;
  scrollbar-width: thin;
}
.gv-saves-empty { padding: 16px 0; text-align: center; color: var(--gv-text-dim); font-size: 12px; }
/* 自动存档常驻槽位：无自动存档时的占位提示框。 */
.gv-saves-auto-empty {
  padding: 10px 0;
  border: 1px dashed var(--gv-line-strong);
  border-radius: 4px;
  background: rgba(16, 20, 38, .4);
}
.gv-saves-actions {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 10px;
}
.gv-saves-group {
  margin: 4px 0 -2px;
  font-size: 10px; letter-spacing: .18em;
  color: var(--gv-text-dim);
}
.gv-saves-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 10px;
  background: rgba(16, 20, 38, .82);
  border: 1px solid var(--gv-line);
  border-radius: 4px;
}
.gv-saves-row.is-current { border-color: rgba(143, 123, 255, .55); background: rgba(143, 123, 255, .08); }
.gv-saves-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--gv-text); }
/* 手动存档名称可点击改名。 */
.gv-saves-name.is-renamable { cursor: text; }
.gv-saves-name.is-renamable:hover { color: #d3b477; }
.gv-saves-edit {
  flex: 1 1 auto; min-width: 0;
  background: rgba(10, 13, 28, .85);
  border: 1px solid rgba(197, 164, 104, .6);
  border-radius: 3px;
  color: var(--gv-text);
  font-size: 12px;
  padding: 2px 6px;
  outline: none;
}
.gv-saves-time { flex: none; font-size: 11px; color: var(--gv-text-dim); font-variant-numeric: tabular-nums; }
.gv-saves-badge {
  flex: none; font-size: 10px; letter-spacing: .1em;
  color: #d3b477; border: 1px solid rgba(197, 164, 104, .45); border-radius: 3px; padding: 0 5px;
}
.gv-saves-create { margin-top: 10px; align-self: stretch; }
.gv-saves-error { margin: 8px 0 0; font-size: 12px; color: var(--gv-accent-red); }
.gv-saves-notice { margin: 8px 0 0; font-size: 12px; color: #8fd3a2; }

/* ---------- 决策面板（等待批准/提问） ----------
 * Galgame 原味版式：无外层包裹框；金色标题 + 蝴蝶结金线分隔 + 垂直并列大选项框；
 * 「算了/先跳过/下一题」与选项并列；提交整合进玩家输入框；背景虚化轻。
 * pending 非空时显示，回答后随 pending 移除自动消失（与官方卡片同一 respond 通道）。 */
.gv-pending-layer {
  position: absolute; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
}
.gv-pending-veil {
  position: absolute; inset: 0;
  background: rgba(5, 8, 18, .32);
}
.gv-pending-stack {
  position: relative; z-index: 1;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  width: min(760px, 96%);
  max-height: 92%;
  overflow-y: auto; scrollbar-width: thin;
  padding: 8px;
  animation: gv-rise .22s cubic-bezier(.16, 1, .3, 1);
}
.gv-pending-approval, .gv-pending-question {
  width: 100%;
  display: flex; flex-direction: column; align-items: center;
}
/* 问题框：皮肤侧边栏同款——四边金色渐变细线 + 四角花纹（纯 CSS 线 + 角落资产）+ 深色打底。 */
.gv-pending-head {
  position: relative;
  box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  max-width: min(760px, 100%);
  border: 0;
  background-color: rgba(10, 13, 28, .78);
  background-image:
    linear-gradient(90deg, rgba(238, 210, 153, .94), rgba(190, 145, 75, .96), rgba(238, 210, 153, .94)),
    linear-gradient(90deg, rgba(238, 210, 153, .94), rgba(190, 145, 75, .96), rgba(238, 210, 153, .94)),
    linear-gradient(180deg, rgba(238, 210, 153, .94), rgba(190, 145, 75, .96), rgba(238, 210, 153, .94)),
    linear-gradient(180deg, rgba(238, 210, 153, .94), rgba(190, 145, 75, .96), rgba(238, 210, 153, .94));
  background-repeat: no-repeat;
  background-size:
    calc(100% - 82px) 1.25px,
    calc(100% - 82px) 1.25px,
    1.35px calc(100% - 40px),
    1.35px calc(100% - 40px);
  background-position:
    left 41px top 6px,
    left 41px bottom 6px,
    left 6px top 20px,
    right 6px top 20px;
  padding: 16px 44px;
  filter: drop-shadow(0 4px 12px rgba(2, 8, 28, .35));
}
/* 四角花纹（皮肤转角资产，四向翻转复用）。 */
.gv-pending-corner {
  position: absolute; width: 40px; height: 40px;
  background: url("${GV_SIDEBAR_CORNER_ART}") top right / 84px 84px no-repeat;
  filter: drop-shadow(0 1px 1px rgba(2, 7, 24, .42));
  pointer-events: none;
}
.gv-pending-corner-tl { top: 1px; left: 1px; transform: scaleX(-1); }
.gv-pending-corner-tr { top: 1px; right: 1px; }
.gv-pending-corner-br { right: 1px; bottom: 1px; transform: scaleY(-1); }
.gv-pending-corner-bl { left: 1px; bottom: 1px; transform: scale(-1); }
.gv-pending-head-row {
  display: flex; align-items: baseline; justify-content: center; gap: 12px;
  max-width: 100%;
}
.gv-pending-eyebrow {
  font-size: 18px; font-weight: 700; letter-spacing: .06em;
  color: #d3b477;
  text-align: center;
  text-shadow: 0 0 12px rgba(197, 164, 104, .35);
}
.gv-pending-title {
  font-size: var(--gv-pending-title-size, 16px); font-weight: 400; letter-spacing: .03em;
  color: #f2dfba;
  text-align: center;
  overflow-wrap: anywhere;
}
.gv-pending-mode {
  flex: none; font-size: 11px; letter-spacing: .1em;
  color: rgba(211, 180, 119, .85);
  border: 1px solid rgba(197, 164, 104, .45); border-radius: 3px; padding: 0 6px;
}
.gv-pending-detail {
  margin: 0; max-width: 640px;
  font-size: var(--gv-pending-detail-size, 15px); line-height: 1.7; color: var(--gv-text);
  text-align: center;
  white-space: pre-wrap; word-break: break-word;
}
.gv-pending-tag {
  flex: none; font-size: 11px; color: #d3b477;
  border: 1px solid rgba(197, 164, 104, .5); border-radius: 3px; padding: 0 6px;
  max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gv-pending-pager { flex: none; font-size: 12px; color: var(--gv-text-dim); font-variant-numeric: tabular-nums; }
.gv-pending-reason {
  margin: 10px 0 0; max-width: 640px;
  font-size: 14px; line-height: 1.7; color: var(--gv-text);
  white-space: pre-wrap; word-break: break-word; text-align: center;
}
/* 金色横线 + 中间蝴蝶结（皮肤资产：透明蝴蝶结 + 皮肤金色渐变线）。 */
.gv-pending-divider {
  display: flex; align-items: center; width: min(760px, 100%);
  margin: 10px 0 4px;
}
.gv-pending-divider::before, .gv-pending-divider::after {
  content: ''; flex: 1; height: 1.25px;
  background: linear-gradient(90deg, transparent, rgba(238, 210, 153, .94), rgba(190, 145, 75, .96), rgba(238, 210, 153, .94), transparent);
}
.gv-pending-bow {
  flex: none; margin: 0 12px;
  width: 110px; height: 50px;
  background: url("${GV_BOW_ART}") center / contain no-repeat;
  filter: drop-shadow(0 3px 7px rgba(4, 11, 35, .45));
}
/* 垂直并列的大选项框：占满面板宽度、字号对齐台词框、
 * 边框使用皮肤「设置」按钮的金色边框（border-image 九宫格）。 */
.gv-pending-options {
  display: flex; flex-direction: column; gap: 10px;
  width: 100%; max-width: 760px;
  margin-top: 10px;
}
.gv-pending-option {
  position: relative;
  display: block; width: 100%;
  box-sizing: border-box;
  border-style: solid;
  border-width: 0 34px;
  border-image-source: url("${GV_SETTINGS_FRAME_ART}");
  border-image-slice: 0 220 0 220 fill;
  border-image-width: 0 34px;
  border-image-repeat: stretch;
  background: none;
  color: #f2dfba;
  font-family: inherit; font-size: var(--gv-pending-option-size, 15px); line-height: 1.6; letter-spacing: .05em;
  text-align: center;
  padding: 12px 8px; border-radius: 0; cursor: pointer;
  filter: drop-shadow(0 4px 10px rgba(2, 8, 28, .3));
  transition: filter .15s ease, color .15s ease, transform .05s ease;
}
.gv-pending-option:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.14) drop-shadow(0 0 12px rgba(238, 210, 153, .35));
}
.gv-pending-option:active:not(:disabled) { transform: scale(.985); }
.gv-pending-option.is-selected {
  color: #fff;
  text-shadow: 0 0 10px rgba(238, 210, 153, .85);
  filter: brightness(1.38) drop-shadow(0 0 18px rgba(238, 210, 153, .65));
}
.gv-pending-option.is-gold { filter: brightness(1.12) drop-shadow(0 4px 10px rgba(2, 8, 28, .3)); }
.gv-pending-option.is-gold:hover:not(:disabled) { filter: brightness(1.24) drop-shadow(0 0 14px rgba(238, 210, 153, .45)); }
.gv-pending-option:disabled { cursor: default; }
/* 选项与编辑框调亮一档（is-choice），与「确定/下一题/先跳过/算了」等动作按钮区分。 */
.gv-pending-option.is-choice {
  filter: brightness(1.14) drop-shadow(0 4px 10px rgba(2, 8, 28, .3));
}
.gv-pending-option.is-choice:hover:not(:disabled) {
  filter: brightness(1.26) drop-shadow(0 0 14px rgba(238, 210, 153, .4));
}
.gv-pending-option.is-choice.is-selected {
  filter: brightness(1.48) drop-shadow(0 0 20px rgba(238, 210, 153, .7));
}
/* 输入 + 提交整合的组合选项框：左边文本输入，右边提交按钮（同款金框，fill 方式与选项一致，
 * 无半透明底——中间面由金框图片自身提供，编辑框自然嵌入）。 */
.gv-pending-answer {
  display: flex; align-items: stretch; gap: 8px;
  box-sizing: border-box;
  border-style: solid;
  border-width: 0 34px;
  border-image-source: url("${GV_SETTINGS_FRAME_ART}");
  border-image-slice: 0 220 0 220 fill;
  border-image-width: 0 34px;
  border-image-repeat: stretch;
  background: none;
  padding: 8px; cursor: default;
  filter: brightness(1.1) drop-shadow(0 4px 10px rgba(2, 8, 28, .3));
}
.gv-pending-answer:active { transform: none; }
.gv-pending-answer-input {
  flex: 1 1 auto; min-width: 0;
  background: rgba(10, 13, 28, .6);
  border: 1px solid rgba(255, 255, 255, .18); border-radius: 4px;
  color: var(--gv-text); font-family: inherit; font-size: var(--gv-pending-option-size, 15px); line-height: 1.6;
  padding: 9px 12px; outline: none; resize: none;
}
.gv-pending-answer-input:focus { border-color: rgba(197, 164, 104, .65); }
.gv-pending-answer-input::placeholder { color: var(--gv-text-dim); }
.gv-pending-answer-submit {
  flex: none;
  border: 1px solid rgba(197, 164, 104, .8); border-radius: 4px;
  background: linear-gradient(180deg, rgba(32, 49, 112, .85), rgba(24, 38, 88, .88));
  color: #eef1fb; font-family: inherit; font-size: 14px; letter-spacing: .08em;
  padding: 0 22px; cursor: pointer;
  transition: border-color .15s ease, box-shadow .15s ease, color .15s ease;
}
.gv-pending-answer-submit:hover:not(:disabled) {
  border-color: #e2cfaa;
  box-shadow: 0 0 12px rgba(197, 164, 104, .35);
  color: #fff;
}
.gv-pending-answer-submit:disabled { opacity: .5; cursor: default; }
.gv-pending-error {
  margin: 10px 0 0; font-size: 13px; color: var(--gv-accent-red);
  line-height: 1.6; text-align: center;
}

/* ---------- 状态活动行 ----------
 * 长链思考过程：思考摘要/工具调用/生成预览/等待决定逐行展示。
 * 各 kind 着色区分；等待决定用暖色醒目。 */
.gv-dtext-activity { display: block; }
.gv-activity-item {
  display: block;
  font-size: .92em;
  line-height: 1.6;
  color: var(--gv-text-dim);
  letter-spacing: .03em;
  white-space: pre-wrap; word-break: break-word;
}
.gv-activity-reasoning { color: #98a1c2; }
.gv-activity-tool, .gv-activity-tool-running { color: var(--gv-accent-2); }
.gv-activity-tool-running { animation: gv-pulse 1.6s ease-in-out infinite; }
.gv-activity-writing { color: var(--gv-text); }
.gv-activity-waiting { color: #ffb86b; font-weight: 600; }
.gv-activity-error { color: var(--gv-accent-red); }
.gv-activity-status { color: var(--gv-text-dim); animation: gv-pulse 1.6s ease-in-out infinite; }

/* ---------- 编辑模式 ----------
 * 舞台槽位与游戏模式同尺寸：工具栏 40px 对齐游戏控制条，底部占位条 84px 对齐输入区；
 * 侧栏悬浮在舞台之上（不挤压舞台），隐藏侧栏时舞台尺寸不变。 */
.gv-editor { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.gv-editor-toolbar {
  flex: none; height: 40px; display: flex; flex-wrap: nowrap; align-items: center; gap: 8px;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  padding: 0 12px;
  border-bottom: 1px solid var(--gv-line);
  background: linear-gradient(180deg, rgba(20, 24, 44, .7), rgba(14, 17, 34, .4));
}
.gv-editor-toolbar::-webkit-scrollbar { height: 0; }
.gv-editor-spacer { flex: none; height: 44px; }
.gv-toolbar-group { display: flex; gap: 4px; align-items: center; }
.gv-toolbar-group + .gv-toolbar-group { border-left: 1px solid var(--gv-line-strong); padding-left: 8px; }
.gv-toolbar-right { margin-left: auto; border-left: 0 !important; }
/* 添加菜单挂在编辑根节点（锚点由 JS 按按钮位置计算），避免被工具栏 overflow 裁剪。 */
.gv-add-menu {
  position: absolute; left: 0; top: 0; z-index: 90;
  min-width: 132px;
  background: var(--gv-panel-2);
  border: 1px solid var(--gv-line-strong);
  box-shadow: 0 14px 36px rgba(0, 0, 0, .5);
  padding: 4px;
  animation: gv-rise .16s cubic-bezier(.16, 1, .3, 1);
}
.gv-add-menu button {
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: transparent; border: 0; color: var(--gv-text);
  font-size: 12px; padding: 5px 8px; cursor: pointer; text-align: left;
}
.gv-add-menu button:hover { background: rgba(143, 123, 255, .14); color: #fff; }

.gv-editor-body { flex: 1 1 auto; min-height: 0; position: relative; }
/* 侧栏悬浮于舞台之上：不挤压舞台，保证编辑所见即游戏所得。 */
.gv-editor-side {
  position: absolute; top: 0; bottom: 0; z-index: 20;
  display: flex; flex-direction: column; overflow: hidden;
  background: rgba(13, 16, 32, .84);
  backdrop-filter: blur(8px) saturate(1.1);
  box-shadow: 0 0 28px rgba(0, 0, 0, .38);
  transition: width .18s cubic-bezier(.16, 1, .3, 1), visibility 0s linear .18s;
}
.gv-editor-tree { left: 0; width: 216px; border-right: 1px solid var(--gv-line-strong); }
.gv-editor-props { right: 0; width: 264px; border-left: 1px solid var(--gv-line-strong); overflow-y: auto; }
/* 边栏隐藏：宽度收拢到 0（保留挂载，状态与动画不丢）。 */
.gv-editor-side.is-collapsed { width: 0 !important; border-left: 0; border-right: 0; visibility: hidden; }
.gv-editor-canvas { position: absolute; inset: 0; display: flex; }
.gv-editor-canvas .gv-stage-wrap { background: radial-gradient(900px 460px at 50% 30%, rgba(30, 36, 70, .5), transparent 70%), #070912; }

/* 元素树 */
.gv-tree { display: flex; flex-direction: column; min-height: 0; }
.gv-tree-root {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--gv-line-strong);
  font-size: 12px; font-weight: 700; letter-spacing: .16em;
}
.gv-tree-count { margin-left: auto; font-size: 10px; font-weight: 400; color: var(--gv-text-dim); letter-spacing: 0; }
.gv-tree-list { flex: 1 1 auto; overflow-y: auto; padding: 4px; }
.gv-tree-row {
  display: flex; align-items: center; gap: 7px;
  padding: 4px 8px; margin: 1px 0;
  font-size: 12px; color: var(--gv-text);
  cursor: pointer; border: 1px solid transparent;
  transition: background .12s ease, border-color .12s ease;
}
.gv-tree-row:hover { background: rgba(255, 255, 255, .05); }
.gv-tree-row.is-selected { background: rgba(143, 123, 255, .14); border-color: rgba(143, 123, 255, .45); }
.gv-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gv-tree-toggle {
  flex: none; border: 1px solid var(--gv-line-strong); background: transparent;
  color: var(--gv-text-dim); font-size: 10px; width: 18px; height: 18px;
  border-radius: 2px; cursor: pointer; line-height: 1; padding: 0;
}
.gv-tree-toggle:hover { color: #fff; border-color: rgba(143, 123, 255, .6); }
.gv-tree-toggle.is-on { color: #fff; background: rgba(143, 123, 255, .22); border-color: rgba(143, 123, 255, .6); }
.gv-tree-toggle.is-off { opacity: .35; }
.gv-tree-scene { flex: none; border-top: 1px solid var(--gv-line-strong); padding: 8px 12px 12px; }

/* 类型记号（纯 CSS 图形） */
.gv-glyph { flex: none; width: 10px; height: 10px; display: inline-block; }
.gv-glyph-scene { border: 1px solid var(--gv-text-dim); box-shadow: inset 0 0 0 2px var(--gv-panel-2), inset 0 0 0 3px var(--gv-text-dim); }
.gv-glyph-background { background: linear-gradient(135deg, var(--gv-accent-2), var(--gv-accent)); opacity: .9; }
.gv-glyph-character { border: 1px solid var(--gv-accent); border-radius: 50% 50% 40% 40%; height: 11px; }
.gv-glyph-dialogue { border: 1px solid var(--gv-accent-2); border-radius: 2px; }
.gv-glyph-dialogue-text { border: 1px solid var(--gv-accent-2); border-radius: 2px; box-shadow: inset 0 -4px 0 rgba(79, 140, 255, .55); }
.gv-glyph-speaker-name { border: 1px solid var(--gv-accent); border-left-width: 3px; border-radius: 2px; }
.gv-glyph-text { background: linear-gradient(90deg, var(--gv-text-dim) 0 70%, transparent 70%); }
.gv-glyph-button { border: 1px solid var(--gv-accent-2); border-radius: 5px; }
.gv-glyph-image { border: 1px solid var(--gv-accent-2); background: linear-gradient(160deg, transparent 52%, var(--gv-accent) 52% 70%, transparent 70%); }
.gv-glyph-rect { border: 1px solid var(--gv-text-dim); }
.gv-glyph-circle { border: 1px solid var(--gv-accent-red); border-radius: 50%; }
.gv-glyph-decoration { border: 1px dashed var(--gv-text-dim); transform: rotate(45deg) scale(.85); }
/* 「台词人设」左侧条目：金调小菱形（与品牌标呼应）。 */
.gv-glyph-persona {
  background: linear-gradient(135deg, rgba(238, 210, 153, .9), rgba(190, 145, 75, .9));
  transform: rotate(45deg) scale(.8);
}
/* 左侧设置条目：与元素行同构，独立成行。 */
.gv-tree-settings { cursor: pointer; }

/* 属性面板 */
.gv-props { padding: 10px 12px 16px; }
.gv-props-head {
  display: flex; align-items: baseline; gap: 8px;
  padding: 2px 0 8px; margin-bottom: 6px;
  border-bottom: 1px solid var(--gv-line-strong);
}
.gv-props-type {
  flex: none; font-size: 10px; letter-spacing: .2em; color: var(--gv-accent);
  border: 1px solid rgba(143, 123, 255, .5); padding: 0 6px; border-radius: 2px;
}
.gv-props-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gv-props-sec {
  margin: 10px 0 4px; padding-bottom: 2px;
  font-size: 10px; letter-spacing: .28em; color: var(--gv-text-dim);
  border-bottom: 1px solid var(--gv-line);
}
.gv-prop-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
.gv-prop-label { flex: none; font-size: 11px; color: var(--gv-text-dim); min-width: 58px; }
.gv-prop-input {
  width: 108px;
  background: rgba(10, 13, 28, .7);
  border: 1px solid var(--gv-line-strong);
  color: var(--gv-text);
  font-size: 12px; padding: 2px 7px; border-radius: 3px; outline: none;
  font-variant-numeric: tabular-nums;
}
.gv-prop-input:focus { border-color: rgba(143, 123, 255, .6); box-shadow: 0 0 8px rgba(143, 123, 255, .15); }
.gv-prop-row input[type="checkbox"] { accent-color: var(--gv-accent); }
.gv-prop-actions { display: flex; gap: 6px; padding: 4px 0; flex-wrap: wrap; }
.gv-prop-actions .gv-btn { font-size: 11px; padding: 2px 8px; }
.gv-prop-color { display: flex; align-items: center; gap: 6px; width: 108px; }
.gv-prop-color input[type="color"] {
  flex: none; width: 30px; height: 22px; padding: 0; border: 1px solid var(--gv-line-strong);
  background: transparent; border-radius: 3px; cursor: pointer;
}
.gv-prop-color-value { flex: 1; font-size: 10px; color: var(--gv-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gv-props-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 16px; color: var(--gv-text-dim); text-align: center; }
.gv-props-empty p { margin: 0; font-size: 12px; }
.gv-props-empty-hint { font-size: 11px !important; line-height: 1.7; opacity: .8; }
.gv-props-empty-mark {
  width: 40px; height: 40px; border: 1px dashed rgba(143, 123, 255, .5);
  transform: rotate(45deg);
}

/* 选中框与手柄 */
.gv-sel {
  position: absolute; z-index: 9999; pointer-events: none;
  border: 1px solid var(--gv-accent);
  box-shadow: 0 0 0 1px rgba(143, 123, 255, .25), 0 0 18px rgba(143, 123, 255, .28);
}
.gv-sel-label {
  position: absolute; top: -20px; left: -1px;
  font-size: 10px; letter-spacing: .1em; color: #fff;
  background: rgba(120, 105, 240, .92);
  padding: 1px 8px; white-space: nowrap;
}
.gv-sel-handle {
  position: absolute; width: 10px; height: 10px;
  background: #0a0d1c; border: 1.5px solid var(--gv-accent);
  pointer-events: auto;
}
.gv-sel-handle:hover { background: var(--gv-accent); box-shadow: 0 0 8px rgba(143, 123, 255, .6); }
.gv-sel-rotate {
  position: absolute; top: -40px; left: calc(50% - 5px);
  width: 10px; height: 10px; border-radius: 50%;
  background: #0a0d1c; border: 1.5px solid var(--gv-accent-2);
  pointer-events: auto; cursor: grab;
}
.gv-sel-rotate::before {
  content: ''; position: absolute; left: 50%; top: 10px;
  width: 1px; height: 28px; background: rgba(79, 140, 255, .5);
  transform: translateX(-50%);
}
.gv-sel-rotate:hover { background: var(--gv-accent-2); }

/* ---------- 动画 ---------- */
@keyframes gv-blink { 50% { opacity: 0; } }
@keyframes gv-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
@keyframes gv-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes gv-slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes gv-rise { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
/* 自动播放转圈提示（auto 按钮旁）。 */
@keyframes gv-spin { to { transform: rotate(360deg); } }
.gv-auto-spin {
  position: absolute; right: 8px; top: 50%;
  width: 10px; height: 10px; margin-top: -5px;
  border: 2px solid rgba(255, 255, 255, .28);
  border-top-color: #fff;
  border-radius: 50%;
  animation: gv-spin .9s linear infinite;
  pointer-events: none;
}

/* ---------- 设置选项卡（渲染在设置面板内，GAL 根节点之外 → 无作用域） ---------- */
.gvsv-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
  font-family: inherit;
}
.gvsv-head { display: flex; flex-direction: column; gap: 4px; }
.gvsv-title { font-size: 15px; font-weight: 700; letter-spacing: .08em; }
.gvsv-desc { font-size: 12px; opacity: .7; line-height: 1.7; }
.gvsv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 4px;
}
.gvsv-label { font-size: 13px; font-weight: 600; }
.gvsv-hint { flex: 1; font-size: 11px; opacity: .6; line-height: 1.6; }
.gvsv-row input[type="checkbox"] { accent-color: #8f7bff; width: 16px; height: 16px; }

@media (prefers-reduced-motion: reduce) {
  [data-gal-view] .gv-el-character .gv-char { animation: none; }
  [data-gal-view] .gv-dialogue-caret { animation: none; }
}
`
