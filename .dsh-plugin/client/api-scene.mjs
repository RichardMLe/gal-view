// ============================================================================
// 场景编辑 api(架构前提 A2 领域拆分):场景/元素/素材/字体编辑与撤销重做。
// 零宿主依赖(只碰自己的 sceneSource/历史/存储),与存档引擎/会话槽 api 合并。
// ============================================================================

import {
  cloneScene, normalizeScene, makeElement, makeId, sortElements, ELEMENT_TYPES,
} from './scene.mjs'
import {
  ASSET_MIME, MAX_ASSET_BYTES, normalizeAsset, readFileAsDataUrl, measureImage,
  embedAssets, extractAssets,
} from './assets.mjs'
import {
  MAX_FONT_BYTES, FONT_FORMATS, normalizeFont, buildFontFace, fontFamilyFromName,
  extOf, embedFonts, extractFonts,
} from './fonts.mjs'
import { loadJSON, saveJSON } from './store.mjs'

/** 场景持久化键(场景域常量,apply 初始化也用它)。 */
export const PERSIST_KEY = 'gal-view:scene:v1'

/** 场景编辑工厂:返回与 createSceneApi 合并的 api 方法面。 */
export function createSceneEditingApi({ sceneSource, history, historySource, storage, assetsSource, idb, fontsSource, fontIdb, seedPresetAssets, presetBase }) {
  const current = () => sceneSource.getSnapshot()
  const commit = next => {
    sceneSource.update(next)
    saveJSON(storage, PERSIST_KEY, next)
  }

  const snapshotScene = () => cloneScene(current())

  const commitHistory = before => {
    if (before === undefined || before === null) return
    const now = current()
    if (JSON.stringify(now) === JSON.stringify(before)) return
    history.push(before)
    historySource.update(history.info())
  }

  const pushAndCommit = next => {
    const before = snapshotScene()
    commit(next)
    history.push(before)
    historySource.update(history.info())
  }

  return {
    /** 快照当前场景（拖动/属性编辑起手）。 */
    snapshotScene,

    /** 实时更新单个元素（不写历史）。 */
    updateElement(id, patch) {
      commit({
        ...current(),
        elements: current().elements.map(el => (el.id === id ? { ...el, ...patch } : el)),
      })
    },

    /** 实时更新设置（浅合并进 settings；不写历史）。 */
    updateSettings(patch) {
      commit({
        ...current(),
        settings: { ...current().settings, ...patch },
      })
    },

    /** 以起手快照提交一次历史（无变化则跳过）。 */
    commitHistory,

    /** 添加元素（自带历史），返回新 id。 */
    addElement(type, opts = {}) {
      if (!ELEMENT_TYPES.includes(type)) return null
      const s = current()
      const index = opts.index ?? s.elements.filter(el => el.type === type).length
      const el = makeElement(type, {
        id: opts.id,
        index,
        role: opts.role,
        stageW: s.settings.stageW,
        stageH: s.settings.stageH,
      })
      pushAndCommit({ ...s, elements: [...s.elements, el] })
      return el.id
    },

    /** 删除元素（自带历史）。 */
    removeElement(id) {
      const s = current()
      pushAndCommit({ ...s, elements: s.elements.filter(el => el.id !== id) })
    },

    /** 复制元素（自带历史），返回副本 id。 */
    duplicateElement(id) {
      const s = current()
      const src = s.elements.find(el => el.id === id)
      if (src === undefined) return null
      const copy = {
        ...cloneScene(src),
        id: makeId('el'),
        name: src.name + ' 副本',
        x: src.x + 16,
        y: src.y + 16,
        z: src.z + 1,
        locked: false,
      }
      pushAndCommit({ ...s, elements: [...s.elements, copy] })
      return copy.id
    },

    /** 图层操作：up/down 交换相邻 z；top/bottom 置为极值。 */
    reorderElement(id, dir) {
      const s = current()
      const sorted = sortElements(s.elements)
      const at = sorted.findIndex(el => el.id === id)
      if (at < 0) return
      const target = sorted[at]
      let z = target.z
      if (dir === 'up' && at < sorted.length - 1) z = sorted[at + 1].z + 0
      else if (dir === 'down' && at > 0) z = sorted[at - 1].z
      else if (dir === 'top') z = (sorted[sorted.length - 1]?.z ?? 0) + 1
      else if (dir === 'bottom') z = (sorted[0]?.z ?? 0) - 1
      if (z === target.z && dir !== 'top' && dir !== 'bottom') {
        // up/down 交换 z
        const other = dir === 'up' ? sorted[at + 1] : sorted[at - 1]
        if (other === undefined) return
        const zA = target.z
        const zB = other.z
        pushAndCommit({
          ...s,
          elements: s.elements.map(el => {
            if (el.id === target.id) return { ...el, z: zB }
            if (el.id === other.id) return { ...el, z: zA }
            return el
          }),
        })
        return
      }
      pushAndCommit({
        ...s,
        elements: s.elements.map(el => (el.id === id ? { ...el, z } : el)),
      })
    },

    /** 导入场景（归一化 + 自带历史；内嵌素材先还原进素材库）。 */
    replaceScene(raw) {
      const next = normalizeScene(raw)
      if (next === null) return false
      const embedded = extractAssets(raw)
      if (embedded.length > 0) {
        const map = new Map(assetsSource.getSnapshot().map)
        for (const record of embedded) {
          map.set(record.id, record)
          void idb.put(record).catch(() => {})
        }
        assetsSource.update({ map })
      }
      const embeddedFonts = extractFonts(raw)
      if (embeddedFonts.length > 0) {
        const map = new Map(fontsSource.getSnapshot().map)
        for (const record of embeddedFonts) {
          map.set(record.id, record)
          void fontIdb.put(record).catch(() => {})
        }
        fontsSource.update({ map })
      }
      pushAndCommit(next)
      return true
    },

    /** 重置为默认预设场景（自带历史；预设素材同步还原进库）。 */
    resetScene() {
      seedPresetAssets()
      pushAndCommit(presetBase())
    },

    /** 撤销 / 重做（真正的 history stack）。 */
    undo() {
      const prev = history.undoStep(snapshotScene())
      if (prev === null) return
      commit(prev)
      historySource.update(history.info())
    },
    redo() {
      const next = history.redoStep(snapshotScene())
      if (next === null) return
      commit(next)
      historySource.update(history.info())
    },

    /** 导出场景 JSON：内嵌被引用的素材与字体 dataURL（组件负责 Blob 下载）。 */
    exportScene() {
      const withAssets = embedAssets(current(), assetsSource.getSnapshot().map)
      return JSON.stringify(embedFonts(withAssets, fontsSource.getSnapshot().map), null, 2)
    },

    /** 素材库：导入图片文件（多选；跳过非图片/超限/损坏项）。 */
    async importAssets(files) {
      const list = Array.isArray(files) ? files : []
      let added = 0
      let skipped = 0
      const ids = []
      for (const file of list) {
        const type = file !== null && typeof file === 'object' ? file.type : ''
        const size = file !== null && typeof file === 'object' ? file.size : Infinity
        if (typeof type !== 'string' || !ASSET_MIME.test(type) || typeof size !== 'number' || size > MAX_ASSET_BYTES) {
          skipped += 1
          continue
        }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const { width, height } = await measureImage(dataUrl)
          const record = normalizeAsset({
            id: makeId('asset'),
            name: typeof file.name === 'string' && file.name !== '' ? file.name : '素材',
            mime: type,
            dataUrl,
            width,
            height,
            createdAt: Date.now(),
          })
          if (record === null) {
            skipped += 1
            continue
          }
          await idb.put(record)
          const map = new Map(assetsSource.getSnapshot().map)
          map.set(record.id, record)
          assetsSource.update({ map })
          ids.push(record.id)
          added += 1
        } catch (error) {
          console.warn('[gal-view] 素材导入失败：' + String(error?.message ?? error))
          skipped += 1
        }
      }
      return { added, skipped, ids }
    },

    /** 素材库：删除素材并清除所有元素引用（一次性历史）。 */
    async removeAsset(id) {
      const map = new Map(assetsSource.getSnapshot().map)
      if (!map.has(id)) return false
      map.delete(id)
      assetsSource.update({ map })
      void idb.remove(id).catch(() => {})
      const s = current()
      if (s.elements.some(el => el.image === id)) {
        pushAndCommit({ ...s, elements: s.elements.map(el => (el.image === id ? { ...el, image: null } : el)) })
      }
      return true
    },

    /** 素材记录查询（组件渲染用；缺失返回 null → 占位图形）。 */
    asset(id) {
      if (typeof id !== 'string' || id === '') return null
      return assetsSource.getSnapshot().map.get(id) ?? null
    },

    /** 字体库：导入字体文件（多选；跳过非字体/超限/损坏项）。 */
    async importFonts(files) {
      const list = Array.isArray(files) ? files : []
      let added = 0
      let skipped = 0
      const ids = []
      for (const file of list) {
        if (file === null || typeof file !== 'object') { skipped += 1; continue }
        const ext = extOf(typeof file.name === 'string' ? file.name : '')
        const format = FONT_FORMATS[ext]
        const mimeOk = typeof file.type === 'string' && /font\/(ttf|otf|woff2?)/i.test(file.type)
        if (format === undefined && !mimeOk) { skipped += 1; continue }
        const size = typeof file.size === 'number' ? file.size : Infinity
        if (size > MAX_FONT_BYTES) { skipped += 1; continue }
        try {
          const dataUrl = await readFileAsDataUrl(file)
          const baseFamily = fontFamilyFromName(typeof file.name === 'string' ? file.name : '')
          const existing = [...fontsSource.getSnapshot().map.values()]
          let family = baseFamily
          let n = 1
          while (existing.some(record => record.family.toLowerCase() === family.toLowerCase())) {
            n += 1
            family = baseFamily + '-' + n
          }
          const record = normalizeFont({
            id: makeId('font'),
            name: typeof file.name === 'string' && file.name !== '' ? file.name : '字体',
            family,
            format: format ?? 'truetype',
            dataUrl,
            createdAt: Date.now(),
          })
          if (record === null) { skipped += 1; continue }
          await fontIdb.put(record)
          const map = new Map(fontsSource.getSnapshot().map)
          map.set(record.id, record)
          fontsSource.update({ map })
          ids.push(record.id)
          added += 1
        } catch {
          skipped += 1
        }
      }
      return { added, skipped, ids }
    },

    /** 字体库：删除字体（元素引用保留 family 字符串，缺失时浏览器自然回退）。 */
    async removeFont(id) {
      const map = new Map(fontsSource.getSnapshot().map)
      if (!map.has(id)) return false
      map.delete(id)
      fontsSource.update({ map })
      void fontIdb.remove(id).catch(() => {})
      return true
    },

    /** 字体记录查询（组件渲染用）。 */
    font(id) {
      if (typeof id !== 'string' || id === '') return null
      return fontsSource.getSnapshot().map.get(id) ?? null
    },
}
}
