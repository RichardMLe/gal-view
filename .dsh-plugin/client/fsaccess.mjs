// 浏览器文件访问层:File System Access API(showDirectoryPicker)写工程文件夹内的
// .gal-view-saves 目录;目录句柄持久化在 IndexedDB(跨刷新复用,不要求每次授权)。
// 不支持 FS Access API 的环境降级为浏览器下载(Downloads 目录),功能不崩。
// 本模块只做 IO 胶水,零业务逻辑(业务在 savefile.mjs)。

const IDB_NAME = 'gal-view-fs'
const IDB_STORE = 'handles'
const IDB_KEY = 'dir'
const SAVES_DIR = '.gal-view-saves'

function openIdb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

/** 从 IndexedDB 读取已保存的目录句柄(可结构化克隆)。 */
export async function loadDirHandle() {
  const db = await openIdb()
  if (db === null) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    } finally {
      try { db.close() } catch { /* 忽略 */ }
    }
  })
}

/** 保存目录句柄到 IndexedDB(失败静默:句柄只本次页面有效)。 */
export async function storeDirHandle(handle) {
  const db = await openIdb()
  if (db === null || handle === null || handle === undefined) return
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(handle, IDB_KEY)
  } catch {
    // 忽略
  } finally {
    try { db.close() } catch { /* 忽略 */ }
  }
}

/** 环境是否支持 FS Access API。 */
export function fsAccessSupported() {
  return typeof window !== 'undefined'
    && typeof window.showDirectoryPicker === 'function'
    && typeof window.isSecureContext === 'boolean' && window.isSecureContext
}

/** 用户手势内调用:弹出目录选择器(用户选工程文件夹,只选一次)。 */
export async function pickDirectory() {
  if (!fsAccessSupported()) return null
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
    if (handle === null || handle === undefined) return null
    await storeDirHandle(handle)
    return handle
  } catch (error) {
    // 用户取消(AbortError)或其他失败:返回 null,调用方给出可读提示。
    console.warn('[gal-view:fs] 选择存档目录失败:', error)
    return null
  }
}

/** 取存档目录句柄(懒创建 .gal-view-saves 子目录);无授权/不支持返回 null。 */
export async function resolveSaveDir() {
  if (!fsAccessSupported()) return null
  const handle = await loadDirHandle()
  if (handle === null || handle === undefined) return null
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' })
    if (permission !== 'granted') {
      const asked = await handle.requestPermission({ mode: 'readwrite' })
      if (asked !== 'granted') return null
    }
    return await handle.getDirectoryHandle(SAVES_DIR, { create: true })
  } catch (error) {
    console.warn('[gal-view:fs] 打开存档目录失败:', error)
    return null
  }
}

/** 目录内全部文件名(仅直接子文件)。 */
export async function listSaveFiles(dir) {
  const names = []
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle !== null && typeof handle === 'object' && handle.kind === 'file') names.push(name)
    }
  } catch (error) {
    console.warn('[gal-view:fs] 列举存档目录失败:', error)
  }
  return names
}

/** 写入文本文件(UTF-8;先写临时名再覆盖目标,尽量原子)。 */
export async function writeSaveFile(dir, name, text) {
  const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_')
  const tmpName = '.' + safeName + '.tmp'
  try {
    const tmp = await dir.getFileHandle(tmpName, { create: true })
    const writable = await tmp.createWritable()
    await writable.write(text)
    await writable.close()
  } catch (error) {
    throw new Error('写入临时文件失败:' + (error?.message ?? String(error)))
  }
  try {
    const target = await dir.getFileHandle(safeName, { create: true })
    const writable = await target.createWritable()
    await writable.write(text)
    await writable.close()
    try { await dir.removeEntry(tmpName) } catch { /* 忽略 */ }
  } catch (error) {
    throw new Error('写入存档失败:' + (error?.message ?? String(error)))
  }
}

/** 读取文本文件;不存在返回 null。 */
export async function readSaveFile(dir, name) {
  try {
    const handle = await dir.getFileHandle(name)
    const file = await handle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

/** 删除文件;不存在返回 false。 */
export async function removeSaveFile(dir, name) {
  try {
    await dir.removeEntry(name)
    return true
  } catch {
    return false
  }
}

/** 降级:浏览器下载(不支持 FS Access API 时)。 */
export function downloadTextFile(name, text) {
  try {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return true
  } catch {
    return false
  }
}
