/** 元素编辑模式：工具栏 + 元素树 + 舞台画布 + 属性面板 + 快捷键。
 * 所有修改实时写入场景（游戏模式同步生效）；离散操作自带历史，拖拽/属性编辑
 * 采用「起手快照 → 实时写 → 收手提交」模式，撤销/重做是真正的 history stack。
 */

import React, { useEffect, useRef, useState } from 'react'
import { StageView } from './StageView.jsx'
import { ELEMENT_TYPES, TYPE_LABELS, sortElements, makeElement } from './scene.mjs'
import { BUILTIN_FONTS } from './fonts.mjs'
import { normalizePersona, PERSONA_POOL_KEYS, PERSONA_POOL_LABELS, thinkingLine, toolLine } from './persona.mjs'

/** 树节点类型记号（纯 CSS 图形，不用 emoji）。 */
function TypeGlyph({ type }) {
  return <span className={'gv-glyph gv-glyph-' + type} aria-hidden="true" />
}

/** 左侧「台词人设」/「选项框」条目选中的哨兵 id（元素 id 不会长这样）。 */
const GAL_PERSONA = 'settings-persona'
const GAL_OPTIONS = 'settings-options'

/** 数值属性行：聚焦快照 → 实时写 → 失焦提交历史。disabled：设置锁定。 */
function NumberField({ label, value, onValue, api, step = 1, min, max, disabled = false }) {
  const baseline = useRef(null)
  const commit = () => {
    if (baseline.current !== null) {
      api.commitHistory(baseline.current)
      baseline.current = null
    }
  }
  return (
    <label className="gv-prop-row">
      <span className="gv-prop-label">{label}</span>
      <input
        type="number"
        className="gv-prop-input"
        value={Math.round(value * 100) / 100}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onFocus={() => { baseline.current = api.snapshotScene() }}
        onChange={e => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onValue(n)
        }}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
  )
}

/** 文本属性行（同历史模式）。 */
function TextField({ label, value, onValue, api, placeholder }) {
  const baseline = useRef(null)
  const commit = () => {
    if (baseline.current !== null) {
      api.commitHistory(baseline.current)
      baseline.current = null
    }
  }
  return (
    <label className="gv-prop-row">
      <span className="gv-prop-label">{label}</span>
      <input
        type="text"
        className="gv-prop-input"
        value={value}
        placeholder={placeholder}
        onFocus={() => { baseline.current = api.snapshotScene() }}
        onChange={e => onValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
  )
}

/** 颜色属性行。 */
function ColorField({ label, value, onValue, api }) {
  const baseline = useRef(null)
  const commit = () => {
    if (baseline.current !== null) {
      api.commitHistory(baseline.current)
      baseline.current = null
    }
  }
  return (
    <label className="gv-prop-row">
      <span className="gv-prop-label">{label}</span>
      <span className="gv-prop-color">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#9b8cff'}
          onFocus={() => { baseline.current = api.snapshotScene() }}
          onChange={e => onValue(e.target.value)}
          onBlur={commit}
        />
        <span className="gv-prop-color-value">{value}</span>
      </span>
    </label>
  )
}

/** 勾选行。disabled：设置锁定。 */
function CheckField({ label, checked, onToggle, api, disabled = false }) {
  return (
    <label className="gv-prop-row">
      <span className="gv-prop-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => {
          const before = api.snapshotScene()
          onToggle(e.target.checked)
          api.commitHistory(before)
        }}
      />
    </label>
  )
}

/** 语气词池字段：多行文本（每行一条），失焦提交（编辑中不打断打字/不丢空行）。disabled：设置锁定。 */
function PoolField({ label, value, onValue, disabled = false }) {
  const [text, setText] = useState(() => (Array.isArray(value) ? value.join('\n') : ''))
  useEffect(() => {
    setText(Array.isArray(value) ? value.join('\n') : '')
  }, [value])
  const commit = () => {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '')
    onValue(lines)
  }
  return (
    <label className="gv-prop-row gv-prop-col">
      <span className="gv-prop-label">{label}</span>
      <textarea
        className="gv-prop-input gv-prop-textarea"
        rows={4}
        value={text}
        disabled={disabled}
        placeholder="每行一条；留空 = 默认模板"
        onChange={e => setText(e.target.value)}
        onBlur={commit}
      />
    </label>
  )
}

/** 属性面板：按选中元素类型渲染可编辑字段。 */
function PropertiesPanel({ el, api, scene, assetsMap, fontsMap }) {
  const update = patch => api.updateElement(el.id, patch)
  const isShape = el.type === 'text' || el.type === 'dialogue-text' || el.type === 'speaker-name' || el.type === 'button' || el.type === 'action-button' || el.type === 'image' || el.type === 'rect' || el.type === 'circle' || el.type === 'decoration' || el.type === 'dialogue' || el.type === 'background'
  return (
    <div className="gv-props">
      <div className="gv-props-head">
        <span className="gv-props-type">{TYPE_LABELS[el.type] ?? el.type}</span>
        <span className="gv-props-title">{el.name !== '' ? el.name : '未命名元素'}</span>
      </div>
      <TextField label="名称" value={el.name} onValue={v => update({ name: v })} api={api} placeholder="元素名称" />
      {isShape && (el.type === 'action-button' || el.type === 'button') && (
        <>
          <div className="gv-props-sec">功能绑定</div>
          <label className="gv-prop-row">
            <span className="gv-prop-label">绑定功能</span>
            <select
              className="gv-prop-input"
              value={el.action ?? ''}
              onChange={e => {
                const before = api.snapshotScene()
                update({ action: e.target.value })
                api.commitHistory(before)
              }}
            >
              <option value="">无（装饰按钮）</option>
              <option value="history">历史</option>
              <option value="auto">自动</option>
              <option value="skip">快进</option>
              <option value="settings">设置</option>
              <option value="save">存档</option>
              <option value="load">读档</option>
            </select>
          </label>
          <p className="gv-settings-hint">游戏模式中点击触发绑定功能（存档/读档需宿主支持会话分叉）；「自动」按钮会随开关状态高亮并带转圈提示。文本/样式照常自定义。</p>
        </>
      )}
      {el.type === 'speaker-name' && (
        <>
          <div className="gv-props-sec">名牌</div>
          <label className="gv-prop-row">
            <span className="gv-prop-label">显示时机</span>
            <select
              className="gv-prop-input"
              value={el.role === 'assistant' ? 'assistant' : 'player'}
              onChange={e => {
                const before = api.snapshotScene()
                update({ role: e.target.value === 'assistant' ? 'assistant' : 'player' })
                api.commitHistory(before)
              }}
            >
              <option value="player">玩家台词时</option>
              <option value="assistant">AI 台词时</option>
            </select>
          </label>
          <p className="gv-settings-hint">名称即下方「文本」字段，自由设置；仅对应一方说话时显示。</p>
        </>
      )}
      <div className="gv-props-sec">位置</div>
      <NumberField label="X" value={el.x} onValue={v => update({ x: v })} api={api} />
      <NumberField label="Y" value={el.y} onValue={v => update({ y: v })} api={api} />
      <div className="gv-props-sec">尺寸</div>
      <NumberField label="宽" value={el.w} min={12} onValue={v => update({ w: v })} api={api} />
      <NumberField label="高" value={el.h} min={12} onValue={v => update({ h: v })} api={api} />
      <div className="gv-props-sec">变换</div>
      <NumberField label="旋转°" value={el.rotation} onValue={v => update({ rotation: v })} api={api} />
      <NumberField label="不透明度%" value={el.opacity * 100} min={0} max={100} onValue={v => update({ opacity: Math.min(1, Math.max(0, v / 100)) })} api={api} />
      <NumberField label="层级" value={el.z} onValue={v => update({ z: v })} api={api} />
      <div className="gv-props-sec">外观</div>
      {el.type === 'character' && (
        <>
          <TextField label="角色名" value={el.character?.name ?? ''} onValue={v => update({ character: { ...(el.character ?? {}), name: v } })} api={api} />
          <TextField label="占位标签" value={el.character?.label ?? ''} onValue={v => update({ character: { ...(el.character ?? {}), label: v } })} api={api} />
          <ColorField label="角色色" value={el.character?.color ?? '#9b8cff'} onValue={v => update({ character: { ...(el.character ?? {}), color: v }, color: v })} api={api} />
        </>
      )}
      {isShape && <TextField label="背景" value={el.background} onValue={v => update({ background: v })} api={api} placeholder="CSS background 值" />}
      <ColorField label="边框色" value={el.borderColor} onValue={v => update({ borderColor: v })} api={api} />
      <NumberField label="边框宽" value={el.borderWidth} min={0} onValue={v => update({ borderWidth: v })} api={api} />
      <NumberField label="圆角" value={el.borderRadius} min={0} onValue={v => update({ borderRadius: v })} api={api} />
      {isShape && <NumberField label="字号" value={el.fontSize} min={8} onValue={v => update({ fontSize: v })} api={api} />}
      {(isShape || el.type === 'character') && <FontPicker el={el} api={api} fontsMap={fontsMap} />}
      {isShape && (
        <label className="gv-prop-row">
          <span className="gv-prop-label">对齐</span>
          <select
            className="gv-prop-input"
            value={el.align ?? 'left'}
            onChange={e => {
              const before = api.snapshotScene()
              update({ align: e.target.value })
              api.commitHistory(before)
            }}
          >
            <option value="left">左对齐</option>
            <option value="center">居中</option>
            <option value="right">右对齐</option>
          </select>
        </label>
      )}
      {isShape && <TextField label="文本" value={el.text} onValue={v => update({ text: v })} api={api} placeholder="占位文本" />}
      {el.type !== 'background' && <ColorField label="文字色" value={el.color} onValue={v => update({ color: v })} api={api} />}
      <div className="gv-props-sec">图片素材</div>
      <AssetPicker el={el} api={api} assetsMap={assetsMap} />
      <div className="gv-props-sec">状态</div>
      <CheckField label="锁定" checked={el.locked} onToggle={v => update({ locked: v })} api={api} />
      <CheckField label="隐藏" checked={el.hidden} onToggle={v => update({ hidden: v })} api={api} />
    </div>
  )
}

/** 字体选择：内置字体 + 导入的自定义字体；自定义字体可删除（引用自然回退）。 */
function FontPicker({ el, api, fontsMap }) {
  const update = patch => api.updateElement(el.id, patch)
  const custom = [...fontsMap.values()].sort((a, b) => b.createdAt - a.createdAt)
  const isCustom = custom.some(record => record.family === el.fontFamily)
  return (
    <>
      <label className="gv-prop-row">
        <span className="gv-prop-label">字体</span>
        <select
          className="gv-prop-input"
          value={el.fontFamily ?? ''}
          onChange={e => {
            const before = api.snapshotScene()
            update({ fontFamily: e.target.value })
            api.commitHistory(before)
          }}
        >
          {BUILTIN_FONTS.map(font => (
            <option key={font.value} value={font.value}>{font.label}</option>
          ))}
          {custom.length > 0 && (
            <optgroup label="自定义字体">
              {custom.map(record => (
                <option key={record.id} value={record.family}>{record.name}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {isCustom && (
        <div className="gv-prop-actions">
          <button
            type="button"
            className="gv-btn"
            onClick={() => {
              const record = custom.find(r => r.family === el.fontFamily)
              if (record !== undefined) void api.removeFont(record.id)
            }}
          >
            从字体库删除
          </button>
        </div>
      )}
    </>
  )
}

/** 图片素材选择：下拉应用/清除 + 导入并应用 + 从素材库删除。 */
function AssetPicker({ el, api, assetsMap }) {
  const fileRef = useRef(null)
  const apply = assetId => {
    const before = api.snapshotScene()
    api.updateElement(el.id, { image: assetId === '' ? null : assetId })
    api.commitHistory(before)
  }
  const onImportAndApply = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file === undefined) return
    void api.importAssets([file]).then(result => {
      if (result.ids.length > 0) apply(result.ids[0])
    })
  }
  const records = [...assetsMap.values()].sort((a, b) => b.createdAt - a.createdAt)
  const current = typeof el.image === 'string' ? assetsMap.get(el.image) ?? null : null
  return (
    <>
      <label className="gv-prop-row">
        <span className="gv-prop-label">素材</span>
        <select
          className="gv-prop-input"
          value={current !== null ? current.id : ''}
          onChange={e => apply(e.target.value)}
        >
          <option value="">无（占位图形）</option>
          {records.map(record => (
            <option key={record.id} value={record.id}>
              {record.name}{record.width > 0 ? '（' + record.width + '×' + record.height + '）' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="gv-prop-actions">
        <button type="button" className="gv-btn" onClick={() => fileRef.current?.click()}>
          导入素材并应用
        </button>
        {current !== null && (
          <button type="button" className="gv-btn" onClick={() => void api.removeAsset(current.id)}>
            从素材库删除
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={onImportAndApply}
        aria-label="导入素材并应用"
      />
    </>
  )
}

/** 元素树：层级序 + 选中 + 锁定/显示切换 + 场景设置区 + 「人设/选项框」入口。
 * 入口条目按用户约定锚定位置：人设跟在「台词」元素后（图标同台词），
 * 选项框跟在「对话框」元素后（图标同对话框）；锚点缺失时排在列表末尾。
 * 入口与元素行同构、语义一致：行位置固定不被隐藏；
 * 「锁」= 设置只读；「隐」= 隐藏对应画布展示范例（人设范例行 / 选项框预览）。
 * 隐藏状态存 scene.settings（随场景持久），与元素 el.hidden 同模式。 */
function ElementTree({ scene, api, selectedId, onSelect }) {
  const rows = [...sortElements(scene.elements)].reverse()
  const persona = normalizePersona(scene.settings.persona)
  const pendingStyle = scene.settings.pendingStyle ?? { locked: false }
  // 组装列表：元素行按 z 序；特殊条目按约定锚定——人设插在「角色」上方，
  // 选项框跟在「对话框」后（行本身永远显示）。
  const personaAnchor = rows.findIndex(el => el.type === 'character')
  const optionsAnchor = rows.findIndex(el => el.type === 'dialogue')
  const items = []
  rows.forEach((el, index) => {
    if (index === personaAnchor) items.push({ kind: 'persona' })
    items.push({ kind: 'element', el })
    if (index === optionsAnchor) items.push({ kind: 'options' })
  })
  if (personaAnchor === -1) items.push({ kind: 'persona' })
  if (optionsAnchor === -1) items.push({ kind: 'options' })
  const renderSettingRow = (id, glyph, label, state, onLock, onHide) => (
    <div
      role="treeitem"
      aria-selected={selectedId === id}
      tabIndex={0}
      className={'gv-tree-row gv-tree-settings' + (selectedId === id ? ' is-selected' : '')}
      onClick={() => onSelect(id)}
      onKeyDown={e => { if (e.key === 'Enter') onSelect(id) }}
    >
      <TypeGlyph type={glyph} />
      <span className="gv-tree-name">{label}</span>
      <button
        type="button"
        className={'gv-tree-toggle' + (state.locked === true ? ' is-on' : '')}
        title={state.locked === true ? '解锁设置' : '锁定设置'}
        aria-label={state.locked === true ? '解锁设置' : '锁定设置'}
        onClick={e => { e.stopPropagation(); onLock(state.locked !== true) }}
      >
        锁
      </button>
      <button
        type="button"
        className={'gv-tree-toggle' + (state.hidden === true ? ' is-off' : '')}
        title={state.hidden === true ? '显示范例' : '隐藏范例'}
        aria-label={state.hidden === true ? '显示范例' : '隐藏范例'}
        onClick={e => { e.stopPropagation(); onHide(state.hidden !== true) }}
      >
        隐
      </button>
    </div>
  )
  return (
    <div className="gv-tree">
      <div className="gv-tree-root">
        <TypeGlyph type="scene" />
        <span>SCENE</span>
        <span className="gv-tree-count">{rows.length} 元素</span>
      </div>
      <div className="gv-tree-list" role="tree" aria-label="元素树">
        {items.map(item => {
          if (item.kind === 'persona') {
            return renderSettingRow(GAL_PERSONA, 'dialogue-text', '人设', persona,
              locked => api.updateSettings({ persona: { ...persona, locked } }),
              hidden => api.updateSettings({ persona: { ...persona, hidden } }))
          }
          if (item.kind === 'options') {
            return renderSettingRow(GAL_OPTIONS, 'dialogue', '选项框', pendingStyle,
              locked => api.updateSettings({ pendingStyle: { ...pendingStyle, locked } }),
              hidden => api.updateSettings({ pendingStyle: { ...pendingStyle, hidden } }))
          }
          const el = item.el
          return (
            <div
              key={el.id}
              role="treeitem"
              aria-selected={el.id === selectedId}
              tabIndex={0}
              className={'gv-tree-row' + (el.id === selectedId ? ' is-selected' : '')}
              onClick={() => onSelect(el.id)}
              onKeyDown={e => { if (e.key === 'Enter') onSelect(el.id) }}
            >
              <TypeGlyph type={el.type} />
              <span className="gv-tree-name">{el.name !== '' ? el.name : TYPE_LABELS[el.type] ?? el.type}</span>
              <button
                type="button"
                className={'gv-tree-toggle' + (el.locked ? ' is-on' : '')}
                title={el.locked ? '解锁' : '锁定'}
                aria-label={el.locked ? '解锁' : '锁定'}
                onClick={e => {
                  e.stopPropagation()
                  api.updateElement(el.id, { locked: !el.locked })
                }}
              >
                锁
              </button>
              <button
                type="button"
                className={'gv-tree-toggle' + (el.hidden ? ' is-off' : '')}
                title={el.hidden ? '显示' : '隐藏'}
                aria-label={el.hidden ? '显示' : '隐藏'}
                onClick={e => {
                  e.stopPropagation()
                  api.updateElement(el.id, { hidden: !el.hidden })
                }}
              >
                隐
              </button>
            </div>
          )
        })}
      </div>
      <div className="gv-tree-scene">
        <div className="gv-props-sec">场景</div>
        <NumberField label="舞台宽" value={scene.settings.stageW} min={320} onValue={v => api.updateSettings({ stageW: v })} api={api} />
        <NumberField label="舞台高" value={scene.settings.stageH} min={180} onValue={v => api.updateSettings({ stageH: v })} api={api} />
        <NumberField label="网格尺寸" value={scene.settings.gridSize} min={4} max={64} onValue={v => api.updateSettings({ gridSize: v })} api={api} />
        <NumberField label="自动存档间隔" value={scene.settings.autoSaveEvery ?? 10} min={0} max={100} onValue={v => api.updateSettings({ autoSaveEvery: v })} api={api} />
        <p className="gv-settings-hint">每完成 N 次对话自动创建「自动」快照（0 = 关闭）；自动快照仅保留最新一个。</p>
      </div>
    </div>
  )
}

/** 人设设置（右侧属性栏；左侧「人设」条目选中时显示）。
 * 设置存入 scene.settings（随场景导出/切换）；读取时归一化，编辑中的非法中间态兜底。
 * locked（条目「锁」）时字段只读。 */
function PersonaPanel({ scene, api }) {
  const persona = normalizePersona(scene.settings.persona)
  const patchPersona = patch => api.updateSettings({ persona: { ...persona, ...patch } })
  const patchPools = (key, lines) => api.updateSettings({ persona: { ...persona, pools: { ...persona.pools, [key]: lines } } })
  const locked = persona.locked === true
  return (
    <div className="gv-props">
      <div className="gv-props-head">
        <span className="gv-props-type">台词</span>
        <span className="gv-props-title">人设</span>
      </div>
      <div className="gv-props-sec">台词人设</div>
      <CheckField label="拟人化" checked={persona.enabled} disabled={locked} onToggle={v => patchPersona({ enabled: v })} api={api} />
      <NumberField label="毒舌率 %" value={persona.witPercent} min={0} max={30} disabled={locked} onValue={v => patchPersona({ witPercent: v })} api={api} />
      {PERSONA_POOL_KEYS.map(key => (
        <PoolField key={key} label={PERSONA_POOL_LABELS[key] ?? key} value={persona.pools[key]} disabled={locked} onValue={lines => patchPools(key, lines)} />
      ))}
      <p className="gv-settings-hint">{locked ? '已锁定：左侧条目「锁」解锁后可编辑。' : '语气词每行一条；留空 = 默认模板。修改实时生效（游戏模式活动行）。'}</p>
    </div>
  )
}

/** 选项框样式（右侧属性栏；左侧「选项框」条目选中时显示；预览在画布中央）。 */
function OptionsPanel({ scene, api }) {
  const pendingStyle = scene.settings.pendingStyle ?? { titleSize: 16, optionSize: 15, detailSize: 15 }
  const patchPending = patch => api.updateSettings({ pendingStyle: { ...pendingStyle, ...patch } })
  const locked = pendingStyle.locked === true
  return (
    <div className="gv-props">
      <div className="gv-props-head">
        <span className="gv-props-type">选项框</span>
        <span className="gv-props-title">样式</span>
      </div>
      <div className="gv-props-sec">选项框样式</div>
      <NumberField label="标题字号" value={pendingStyle.titleSize} min={10} max={24} disabled={locked} onValue={v => patchPending({ titleSize: v })} api={api} />
      <NumberField label="选项字号" value={pendingStyle.optionSize} min={10} max={24} disabled={locked} onValue={v => patchPending({ optionSize: v })} api={api} />
      <NumberField label="说明字号" value={pendingStyle.detailSize} min={10} max={24} disabled={locked} onValue={v => patchPending({ detailSize: v })} api={api} />
      <p className="gv-settings-hint">{locked ? '已锁定：左侧条目「锁」解锁后可编辑。' : '控制提问/批准面板的标题、选项与说明文字大小；预览显示在画布中央（即决策面板实际出现的位置）。'}</p>
    </div>
  )
}

/** 选项框实时预览：常驻画布中央的覆盖层（= 游戏模式决策面板实际出现位置）。
 * 复用真实决策面板样式与 CSS 变量，字号调整即时生效；pointer-events:none 不干扰编辑。
 * 「隐」后不渲染（settings.pendingStyle.hidden）。 */
function OptionsPreview({ scene }) {
  const pendingStyle = scene.settings.pendingStyle ?? { titleSize: 16, optionSize: 15, detailSize: 15 }
  if (pendingStyle.hidden === true) return null
  const vars = {
    '--gv-pending-title-size': String(pendingStyle.titleSize ?? 16) + 'px',
    '--gv-pending-option-size': String(pendingStyle.optionSize ?? 15) + 'px',
    '--gv-pending-detail-size': String(pendingStyle.detailSize ?? 15) + 'px',
  }
  return (
    <div className="gv-options-preview-stage" style={vars} aria-hidden="true">
      <div className="gv-pending-head">
        <span className="gv-pending-corner gv-pending-corner-tl" />
        <span className="gv-pending-corner gv-pending-corner-tr" />
        <span className="gv-pending-corner gv-pending-corner-br" />
        <span className="gv-pending-corner gv-pending-corner-bl" />
        <div className="gv-pending-head-row">
          <span className="gv-pending-title">标题（{pendingStyle.titleSize}px）</span>
          <span className="gv-pending-mode">单选</span>
        </div>
        <p className="gv-pending-detail">说明文字会随「说明字号」即时变化。</p>
      </div>
      <div className="gv-pending-divider">
        <span className="gv-pending-bow" />
      </div>
      <div className="gv-pending-options">
        <div className="gv-pending-option is-choice">选项一（{pendingStyle.optionSize}px）</div>
        <div className="gv-pending-option is-choice">选项二</div>
      </div>
    </div>
  )
}

/** 人设展示范例：常驻画布右下角（活动行实际出现区域）的两行台词演示。
 * 取自当前配置的词池（拟人化关闭时显示纯状态行）；「隐」后不渲染（settings.persona.hidden）。 */
function PersonaPreview({ scene }) {
  const persona = normalizePersona(scene.settings.persona)
  if (persona.hidden === true) return null
  const cfg = persona.enabled === true ? persona : null
  const line1 = thinkingLine('先看看目录结构，再决定怎么处理', cfg)
  const line2 = toolLine('整理文件', 'preview-call', cfg)
  return (
    <div className="gv-persona-preview" aria-hidden="true">
      <span className="gv-persona-preview-line gv-activity-reasoning">{line1}</span>
      <span className="gv-persona-preview-line gv-activity-tool">{line2}</span>
    </div>
  )
}

/** 边栏显隐偏好 + 设置条目隐藏偏好（localStorage；隐私模式/异常时用默认值）。 */
const PANELS_KEY = 'gal-view:editor-panels'
function loadPanels() {
  try {
    const raw = window.localStorage.getItem(PANELS_KEY)
    if (raw === null) return { tree: true, props: true, hiddenSettings: { persona: false, options: false } }
    const parsed = JSON.parse(raw)
    return {
      tree: parsed.tree !== false,
      props: parsed.props !== false,
      hiddenSettings: {
        persona: parsed.hiddenSettings?.persona === true,
        options: parsed.hiddenSettings?.options === true,
      },
    }
  } catch {
    return { tree: true, props: true, hiddenSettings: { persona: false, options: false } }
  }
}
function savePanels(panels) {
  try {
    window.localStorage.setItem(PANELS_KEY, JSON.stringify(panels))
  } catch {
    // 隐私模式/配额：忽略（偏好仅本次会话内有效）。
  }
}

/** 编辑模式整体。 */
export function Editor({ scene, api, history, assetsMap, fontsMap, onExitEditor }) {
  const [selectedId, setSelectedId] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addMenuPos, setAddMenuPos] = useState(null)
  const [panels, setPanels] = useState(loadPanels)
  const fileRef = useRef(null)
  const assetFileRef = useRef(null)
  const fontFileRef = useRef(null)
  const editorRef = useRef(null)
  const addBtnRef = useRef(null)
  const addMenuRef = useRef(null)
  const imageFileRef = useRef(null)
  const pendingImageElRef = useRef(null)
  const selected = scene.elements.find(el => el.id === selectedId) ?? null
  // 左侧「台词人设/选项框」条目选中 → 右侧属性栏显示对应设置面板。
  const personaOpen = selectedId === GAL_PERSONA
  const optionsOpen = selectedId === GAL_OPTIONS

  // 添加菜单渲染在编辑根节点（工具栏 overflow 裁剪会把下坠菜单切掉），
  // 打开时按按钮位置计算锚点；点击菜单外关闭。
  const toggleAddMenu = () => {
    if (addOpen) {
      setAddOpen(false)
      setAddMenuPos(null)
      return
    }
    const btn = addBtnRef.current?.getBoundingClientRect()
    const root = editorRef.current?.getBoundingClientRect()
    setAddMenuPos(btn !== undefined && root !== undefined
      ? { left: btn.left - root.left, top: btn.bottom - root.top + 4 }
      : { left: 0, top: 44 })
    setAddOpen(true)
  }
  useEffect(() => {
    if (!addOpen) return
    const onDown = e => {
      const target = e.target
      if (addMenuRef.current?.contains(target) || addBtnRef.current?.contains(target)) return
      setAddOpen(false)
      setAddMenuPos(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown) }
  }, [addOpen])

  const togglePanel = key => {
    setPanels(prev => {
      const next = { ...prev, [key]: !prev[key] }
      savePanels(next)
      return next
    })
  }

  useEffect(() => {
    const onKey = e => {
      const target = e.target
      const typing = target instanceof HTMLElement
        && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      if (e.key === 'Escape') {
        if (selectedId !== null) setSelectedId(null)
        else onExitEditor()
        return
      }
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedId !== null) {
          e.preventDefault()
          api.removeElement(selectedId)
          setSelectedId(null)
        }
      } else if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        if (selectedId !== null) setSelectedId(api.duplicateElement(selectedId))
      } else if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) api.redo()
        else api.undo()
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        api.redo()
      } else if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        downloadScene(api.exportScene())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [selectedId, api, onExitEditor])

  const addElement = (type, role) => {
    const count = scene.elements.filter(el => el.type === type).length
    const letter = String.fromCharCode(65 + (scene.elements.filter(el => el.type === 'character').length % 26))
    const id = api.addElement(type, { index: type === 'character' ? count : 0, letter, role })
    setAddOpen(false)
    setAddMenuPos(null)
    setSelectedId(id)
    // 「导入图片」：创建元素后直接打开文件选择，导入并应用（一步到位）。
    if (type === 'image') {
      pendingImageElRef.current = id
      imageFileRef.current?.click()
    }
  }

  /** 「导入图片」元素的文件选择：导入素材并应用到刚创建的元素。 */
  const onImportImage = e => {
    const files = e.target.files
    // 先固化文件对象再清空 input：清空 value 会让 FileList 变为空（文件对象本身不受影响）。
    const list = files === null ? [] : Array.from(files)
    e.target.value = ''
    if (list.length === 0) return
    const targetId = pendingImageElRef.current
    pendingImageElRef.current = null
    void api.importAssets(list).then(result => {
      if (result.ids.length > 0 && targetId !== null) {
        const before = api.snapshotScene()
        api.updateElement(targetId, { image: result.ids[0] })
        api.commitHistory(before)
      }
    })
  }

  const onImportFile = e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const ok = api.replaceScene(JSON.parse(String(reader.result)))
        if (ok) setSelectedId(null)
      } catch {
        // 非法 JSON：忽略（replaceScene 也会拒绝非对象输入）。
      }
    }
    reader.readAsText(file)
  }

  /** 导入素材：多选图片进入素材库（随后在属性面板应用到元素）。 */
  const onImportAssets = e => {
    const files = e.target.files
    e.target.value = ''
    if (files === null || files.length === 0) return
    void api.importAssets([...files]).then(result => {
      if (result.added === 0) console.warn('[gal-view] 素材导入失败或全部跳过')
    })
  }

  /** 导入字体：多选字体文件进入字体库（随后在属性面板「字体」下拉选择）。 */
  const onImportFonts = e => {
    const files = e.target.files
    e.target.value = ''
    if (files === null || files.length === 0) return
    void api.importFonts([...files]).then(result => {
      if (result.added === 0) console.warn('[gal-view] 字体导入失败或全部跳过')
    })
  }

  return (
    <div className="gv-editor" ref={editorRef}>
      <div className="gv-editor-toolbar" role="toolbar" aria-label="编辑器工具栏">
        <div className="gv-toolbar-group">
          <button ref={addBtnRef} type="button" className="gv-btn gv-btn-accent" onClick={toggleAddMenu}>＋ 添加元素</button>
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => { if (selected !== null) setSelectedId(api.duplicateElement(selected.id)) }} title="Ctrl+D">复制</button>
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => { if (selected !== null) { api.removeElement(selected.id); setSelectedId(null) } }} title="Delete">删除</button>
        </div>
        <div className="gv-toolbar-group">
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => selected !== null && api.reorderElement(selected.id, 'up')}>上移</button>
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => selected !== null && api.reorderElement(selected.id, 'down')}>下移</button>
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => selected !== null && api.reorderElement(selected.id, 'top')}>置顶</button>
          <button type="button" className="gv-btn" disabled={selected === null} onClick={() => selected !== null && api.reorderElement(selected.id, 'bottom')}>置底</button>
        </div>
        <div className="gv-toolbar-group">
          <button type="button" className={'gv-btn gv-toggle' + (scene.settings.showGrid ? ' is-on' : '')} onClick={() => api.updateSettings({ showGrid: !scene.settings.showGrid })}>网格</button>
          <button type="button" className={'gv-btn gv-toggle' + (scene.settings.snap ? ' is-on' : '')} onClick={() => api.updateSettings({ snap: !scene.settings.snap })}>吸附</button>
        </div>
        <div className="gv-toolbar-group">
          <button type="button" className={'gv-btn gv-toggle' + (panels.tree ? ' is-on' : '')} aria-pressed={panels.tree} onClick={() => togglePanel('tree')}>元素树</button>
          <button type="button" className={'gv-btn gv-toggle' + (panels.props ? ' is-on' : '')} aria-pressed={panels.props} onClick={() => togglePanel('props')}>属性</button>
        </div>
        <div className="gv-toolbar-group">
          <button type="button" className="gv-btn" disabled={history.undo === 0} onClick={() => api.undo()} title="Ctrl+Z">撤销</button>
          <button type="button" className="gv-btn" disabled={history.redo === 0} onClick={() => api.redo()} title="Ctrl+Y">重做</button>
        </div>
        <div className="gv-toolbar-group gv-toolbar-right">
          <button type="button" className="gv-btn" onClick={() => fileRef.current?.click()}>导入场景</button>
          <button type="button" className="gv-btn" onClick={() => assetFileRef.current?.click()}>导入素材</button>
          <button type="button" className="gv-btn" onClick={() => fontFileRef.current?.click()}>导入字体</button>
          <button type="button" className="gv-btn" onClick={() => downloadScene(api.exportScene())} title="Ctrl+S">导出</button>
          <button type="button" className="gv-btn" onClick={() => { api.resetScene(); setSelectedId(null) }}>重置</button>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={onImportFile} aria-label="导入场景 JSON" />
          <input ref={assetFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple style={{ display: 'none' }} onChange={onImportAssets} aria-label="导入图片素材" />
          <input ref={imageFileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} onChange={onImportImage} aria-label="导入图片" />
          <input ref={fontFileRef} type="file" accept=".ttf,.otf,.woff,.woff2" multiple style={{ display: 'none' }} onChange={onImportFonts} aria-label="导入字体文件" />
        </div>
      </div>
      <div className="gv-editor-body">
        <div className={'gv-editor-side gv-editor-tree' + (panels.tree ? '' : ' is-collapsed')} aria-hidden={!panels.tree}>
          <ElementTree scene={scene} api={api} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div className="gv-editor-canvas">
          <StageView
            scene={scene}
            assetsMap={assetsMap}
            mode="editor"
            line={null}
            type={{ target: '', shown: '', done: true }}
            running={false}
            selectedId={selectedId}
            onSelect={setSelectedId}
            api={api}
            onSkip={() => {}}
          />
          {/* 设置展示范例常驻画布（与元素渲染一致）；「隐」= 隐藏范例（行保留，settings.hidden）。 */}
          <PersonaPreview scene={scene} />
          <OptionsPreview scene={scene} />
        </div>
        <div className={'gv-editor-side gv-editor-props' + (panels.props ? '' : ' is-collapsed')} aria-hidden={!panels.props}>
          {optionsOpen
            ? <OptionsPanel scene={scene} api={api} />
            : personaOpen
              ? <PersonaPanel scene={scene} api={api} />
              : selected !== null
                ? <PropertiesPanel el={selected} api={api} scene={scene} assetsMap={assetsMap} fontsMap={fontsMap} />
                : (
                    <div className="gv-props-empty">
                      <span className="gv-props-empty-mark" aria-hidden="true" />
                      <p>未选择元素</p>
                      <p className="gv-props-empty-hint">在画布或元素树中点选元素，编辑其位置、尺寸与外观</p>
                  </div>
                )}
        </div>
      </div>
      {/* 与游戏模式输入区等高（84px）的占位条：保证舞台槽位两模式一致。 */}
      <div className="gv-editor-spacer" aria-hidden="true" />
      {/* 添加元素菜单：挂在编辑根节点，锚点按按钮位置计算（不受工具栏裁剪）。 */}
      {addOpen && addMenuPos !== null && (
        <div className="gv-add-menu" role="menu" ref={addMenuRef} style={{ left: addMenuPos.left, top: addMenuPos.top }}>
          {ELEMENT_TYPES.flatMap(type => {
            if (type === 'speaker-name') {
              return [
                { key: 'speaker-player', label: '玩家名牌', role: 'player', type },
                { key: 'speaker-ai', label: 'AI 名牌', role: 'assistant', type },
              ]
            }
            return [{ key: type, label: TYPE_LABELS[type], role: undefined, type }]
          }).map(entry => (
            <button key={entry.key} type="button" role="menuitem" onClick={() => addElement(entry.type, entry.role)}>
              <TypeGlyph type={entry.type} />
              {entry.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 导出：Blob 下载场景 JSON。 */
function downloadScene(json) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'gal-scene.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}
