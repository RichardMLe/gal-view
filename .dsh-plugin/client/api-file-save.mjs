// ============================================================================
// 存档引擎(架构前提 A2 领域拆分):文件式存档/读档/迁移/转写/完整性检查。
// 依赖宿主适配层 host-adapter;跨领域方法(currentSessionId/mainTitle 等)经 this 调用
// (本工厂产物与场景编辑/会话槽 api 合并为同一对象)。
// ============================================================================

import {
  fsAccessSupported, pickDirectory, resolveSaveDir, prepareSaveDir, loadDirHandle, listSaveFiles,
  writeSaveFile, readSaveFile, removeSaveFile, downloadTextFile,
  writeSaveZip, downloadBlobFile, withTimeout,
} from './fsaccess.mjs'
import {
  buildSaveDoc, parseSaveDoc, linesToText, slotIdFromFileName, slotFromFileName,
  nextFileSlotId, fileSlotPrefix, isAncestorOf,
} from './savefile.mjs'
import { wireEventsToLines } from './transcript-log.mjs'
import { assistantDisplayName } from './transcript.mjs'
import {
  buildSessionPageRequest, readSessionPageResponse, windowTailSeqFromEntries, sessionOf,
} from './host-adapter.mjs'

/** 存档引擎工厂:返回与 createSceneApi 合并的 api 方法面。 */
export function createFileSaveApi({ sceneSource, sessionsSvc, workspacesSvc, connectionSvc }) {
  let saveLocked = false
  return {
    /** 存档目录状态:{ supported, ready }。supported=浏览器支持 FS Access API。 */
    saveDirStatus() {
      return { supported: fsAccessSupported() }
    },
    /** 用户手势内调用:选一次工程文件夹(句柄持久化,之后静默)。返回是否成功。 */
    async ensureSaveDir() {
      if (!fsAccessSupported()) return false
      const dir = await resolveSaveDir()
      if (dir !== null) return true
      const picked = await pickDirectory()
      return picked !== null
    },
    /** 手动存档入口专用:手势内准备存档目录(复用已授权或弹系统选择框)。
     * 必须在点击处理器里尽早调用——requestPermission/showDirectoryPicker 脱离
     * 用户手势会被浏览器拒绝(旧流程在导出后才解析目录,是「已授权还反复提示」
     * 的根因)。返回 { status: 'ready'|'picked'|'cancelled'|'unsupported', dir }。
     * opts.force=true(面板「重新选择」按钮):跳过已授权复用,直接弹系统选择框。 */
    async prepareSaveDir(opts = {}) {
      if (opts.force === true) {
        if (!fsAccessSupported()) return { status: 'unsupported', dir: null }
        const picked = await pickDirectory()
        if (picked === null || picked === undefined) return { status: 'cancelled', dir: null }
        const dir = await resolveSaveDir()
        return dir !== null ? { status: 'picked', dir } : { status: 'cancelled', dir: null }
      }
      return prepareSaveDir()
    },
    /** 扫描目录列出文件槽位(读每个文件头解析元数据;损坏/非本插件文件跳过)。
     * 需求:只显示当前工程前缀匹配的存档;自动存档仅显示最新一条。 */
    async listFileSlots() {
      const dir = await resolveSaveDir()
      const saves = []
      const autos = []
      const broken = []
      if (dir === null) return { ready: false, rootTitle: '', saves, autos, broken }
      const mainTitle = this.mainTitle()
      const prefix = fileSlotPrefix(mainTitle)
      // 名字级工程过滤;迁移条目(legacySlotId)文件名带「旧+会话id」不匹配前缀,
      // 但它们必然来自当前工程的旧注册表,一律放行。
      const nameInProject = (name) => {
        if (prefix === '') return true
        const id = slotIdFromFileName(name)
        return id === '' || id.startsWith(prefix)
      }
      const names = await withTimeout(listSaveFiles(dir), 8000, [])
      const mdNames = new Set()
      for (const name of names) {
        if (name.toLowerCase().endsWith('.zip')) continue
        const id = slotIdFromFileName(name)
        if (id === '') continue
        const text = await withTimeout(readSaveFile(dir, name), 5000, null)
        if (text === null) {
          if (nameInProject(name)) broken.push(name)
          continue
        }
        const doc = parseSaveDoc(text)
        if (doc === null) {
          if (nameInProject(name)) broken.push(name)
          continue
        }
        const belongs = nameInProject(name) || doc.meta.legacySlotId !== null
        if (!belongs) continue
        mdNames.add(name)
        const entry = {
          id,
          name,
          title: doc.meta.title,
          savedAt: doc.meta.savedAt,
          turns: doc.meta.turns,
          auto: doc.meta.auto,
        }
        if (doc.meta.auto) autos.push(entry)
        else saves.push(entry)
      }
      // 孤儿 zip:没有对应 md 的日志备份(如手工删了 md),提示可清理。
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.zip')) continue
        const id = slotIdFromFileName(name)
        if (id !== '' && mdNames.has(id + '.md')) continue
        if (!nameInProject(name)) continue
        broken.push(name + '(孤立日志)')
      }
      saves.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN', { numeric: true }))
      autos.sort((a, b) => a.savedAt - b.savedAt)
      // 需求:自动存档仅保留最新一个(显示层只显示最新;写入层已有物理清理)。
      const latestAutos = autos.length > 0 ? [autos[autos.length - 1]] : []
      return { ready: true, rootTitle: mainTitle, saves, autos: latestAutos, broken }
    },
    /** 把采集好的记录写入存档文件(纯文件操作,不碰官方会话系统)。
     * payload: { auto, rootTitle, sessionId, atSeq, assistantName, turns, lines,
     *            complete, zip(Uint8Array|null), exportNote, dir(可选,已解析句柄) }
     * 写入顺序:先 zip(官方完整日志),再 md(可读记录+元数据);md 失败回滚 zip。
     * 自动档仅保留最新:新档全部成功后清理旧自动档的 md+zip。 */
    async saveSlotFile(payload) {
      if (payload.atSeq === null || payload.atSeq === undefined) throw new Error('还没有已完成的对话,先聊两句再存档吧')
      const dir = payload.dir ?? await resolveSaveDir()
      const existing = dir !== null ? await listSaveFiles(dir) : []
      const ids = existing.map(slotIdFromFileName).filter(id => id !== '')
      const prefix = fileSlotPrefix(payload.rootTitle)
      const id = nextFileSlotId(prefix, ids, payload.auto === true)
      const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : id
      const name = id + '.md'
      const zipName = id + '.zip'
      const hasZip = payload.zip !== null && payload.zip !== undefined && payload.zip !== ''
      const noteBase = typeof payload.exportNote === 'string' && payload.exportNote !== '' ? payload.exportNote + '。' : ''
      const note = noteBase + (noteBase === '' && !hasZip ? '官方日志导出不可用,完整记录以文本转录为准。' : '')
      const text = buildSaveDoc({ ...payload, title, note: note === '' ? undefined : note })
      if (dir === null) {
        if (fsAccessSupported()) {
          // 支持但未授权:首次存档需要用户授权一次(面板引导)。
          const error = new Error('首次存档需要授权文件夹(请点击「选择存档文件夹」)')
          error.code = 'dir-unauthorized'
          throw error
        }
        // 环境不支持:降级浏览器下载(Downloads)。
        let ok = true
        if (hasZip) ok = downloadBlobFile(zipName, payload.zip, 'application/zip') && ok
        ok = downloadTextFile(name, text) && ok
        if (!ok) throw new Error('下载存档失败(浏览器不支持文件写入)')
        return { id, name, title, fallback: true }
      }
      // ① 官方完整日志 zip(先写)
      if (hasZip) {
        await writeSaveZip(dir, zipName, payload.zip)
        console.info('[gal-view:save] 日志备份写入:', zipName)
      }
      // ② 可读记录 md;失败回滚 zip
      try {
        await writeSaveFile(dir, name, text)
      } catch (cause) {
        if (hasZip) { try { await removeSaveFile(dir, zipName) } catch { /* 忽略 */ } }
        throw cause
      }
      console.info('[gal-view:save] 存档文件写入:', name, '(atSeq=' + payload.atSeq + ', 完整日志=' + String(hasZip) + ')')
      // ③ 自动档清理(新档成功后)
      if (payload.auto === true) {
        for (const oldName of existing) {
          const slot = slotFromFileName(oldName, prefix)
          if (slot !== null && slot.auto && slot.id !== id) {
            await removeSaveFile(dir, oldName)
            await removeSaveFile(dir, slot.id + '.zip')
            console.info('[gal-view:save] 清理旧自动档文件:', oldName)
          }
        }
      }
      this.noteSaveOp()
      return { id, name, title, fallback: false }
    },
    /** 读文件存档:解析 → fork(当前主线, atSeq=存档点) → 打开新线。
     * 读档后是否归档旧线由设置项「读档后归档旧对话」控制(默认关,旧线保留可切回)。
     * fork 不可用(主线不含该锚点/跨工程)时降级:新建会话 + 记录文本注入。 */
    async loadSaveFile(id) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const name = id.toLowerCase().endsWith('.md') ? id : id + '.md'
      const text = await readSaveFile(dir, name)
      if (text === null) throw new Error('存档文件已丢失(可能被移动或删除)')
      const doc = parseSaveDoc(text)
      if (doc === null) throw new Error('存档文件无法解析(格式损坏或不是本插件生成的存档)')
      // 迁移条目(旧式槽转来):读档走原会话槽 fork 路径——槽是独立分支,
      // fork-atSeq 无法精确锚定,绝不混用。
      if (doc.meta.legacySlotId !== null) {
        console.info('[gal-view:save] load-file: 迁移条目,走原会话槽读档:', doc.meta.legacySlotId)
        const legacyResult = await this.loadSave(doc.meta.legacySlotId)
        this.noteSaveOp()
        void this.checkConversationIntegrity()
        return { childId: legacyResult.childId, mode: 'legacy', lines: doc.lines, title: doc.meta.title }
      }
      const mainId = this.currentSessionId()
      if (mainId === null) throw new Error('未找到当前会话')
      const mainTitle = this.mainTitle()
      console.info('[gal-view:save] load-file: 解析成功', doc.meta.title, 'atSeq=' + String(doc.meta.atSeq), 'sessionId=' + doc.meta.sessionId)
      // 世界线校验:存档会话必须在当前主线的祖先链上(或就是主线),fork-atSeq
      // 才能精确切回存档点;否则官方会静默切到"最后一个完成回合",内容漂移。
      const snapForChain = sessionsSvc?.list?.getSnapshot?.() ?? null
      const byId = snapForChain !== null && typeof snapForChain === 'object' ? snapForChain.byId ?? {} : {}
      const anchored = doc.meta.sessionId === mainId || isAncestorOf(byId, doc.meta.sessionId, mainId)
      try {
        // 世界线校验:存档会话必须在当前主线的祖先链上(或就是主线),fork-atSeq
        // 才能精确切回存档点;否则官方会静默切到"最后一个完成回合",内容漂移,
        // 直接走内容级还原降级。
        if (!anchored) {
          console.warn('[gal-view:save] load-file: 存档会话不在当前主线祖先链上,跳过 fork-atSeq,降级为内容级还原:', doc.meta.sessionId, '→', mainId)
          throw new Error('worldline-detached')
        }
        if (!this.hasSessionsService()) throw new Error('当前环境不支持会话分叉')
        if (doc.meta.atSeq === null) throw new Error('该存档没有存档点,无法按分叉还原')
        const childId = await sessionsSvc.fork({ sessionId: mainId, atSeq: doc.meta.atSeq })
        console.info('[gal-view:save] load-file: fork-atSeq 完成', childId)
        await sessionsSvc.open(childId)
        await this.waitCurrentIs(childId, 2000)
        if (mainTitle !== '' && mainTitle !== doc.meta.title) {
          try {
            const binding = sessionsSvc.binding?.(childId)
            const session = binding?.session ?? null
            if (session !== null && typeof session.rename === 'function') await session.rename(mainTitle)
          } catch {
            // 忽略:保留继承名
          }
        }
        if (sceneSource.getSnapshot().settings.archiveOldOnLoad === true) {
          if (this.currentSessionId() === mainId) {
            console.warn('[gal-view:save] load-file: 当前会话仍未切换,放弃归档旧线:', mainId)
          } else {
            await this.archiveSessionQuiet(mainId)
          }
        } else {
          console.info('[gal-view:save] load-file: 设置未开启归档,旧线保留在工作区:', mainId)
        }
        this.noteSaveOp()
        void this.checkConversationIntegrity()
        return { childId, mode: 'fork', lines: doc.lines, title: doc.meta.title }
      } catch (cause) {
        console.warn('[gal-view:save] load-file: fork 还原失败,降级为内容级还原:', cause)
        if (!this.hasSessionsService() || typeof sessionsSvc.create !== 'function') throw cause
        const created = await sessionsSvc.create({})
        const createdId = typeof created === 'string' ? created : created?.sessionId ?? created?.value?.sessionId
        if (typeof createdId !== 'string' || createdId === '') throw cause
        await sessionsSvc.open(createdId)
        const recordText = linesToText(doc.lines, doc.meta.assistantName)
        this.noteSaveOp()
        void this.checkConversationIntegrity()
        return { childId: createdId, mode: 'inject', lines: doc.lines, title: doc.meta.title, recordText }
      }
    },
    /** 删除文件存档(直接删文件;不存在返回 false)。 */
    async deleteSlotFile(id) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const name = id.toLowerCase().endsWith('.md') ? id : id + '.md'
      const zipName = slotIdFromFileName(name) + '.zip'
      const removed = await withTimeout(removeSaveFile(dir, name), 5000, false)
      await withTimeout(removeSaveFile(dir, zipName), 5000, false)
      console.info('[gal-view:save] 删除存档文件:', name, '->', String(removed))
      return removed
    },
    /** 删除「无法识别」的杂项文件(面板列出的 broken 条目;兼容孤立 zip 后缀)。 */
    async deleteBrokenFile(name) {
      const dir = await resolveSaveDir()
      if (dir === null) throw new Error('未选择存档文件夹')
      const clean = String(name).replace('(孤立日志)', '')
      if (clean === '') return false
      const removed = await withTimeout(removeSaveFile(dir, clean), 5000, false)
      if (clean.toLowerCase().endsWith('.md')) {
        await withTimeout(removeSaveFile(dir, clean.replace(/\.md$/i, '') + '.zip'), 5000, false)
      }
      console.info('[gal-view:save] 删除无法识别文件:', clean, '->', String(removed))
      return removed
    },
    /** 官方会话日志导出:GET /api/session.export → 完整日志 zip(Uint8Array)。
     * 纯后台流式下载,不碰会话窗口;失败抛错(调用方决定兜底)。 */
    async exportSessionLog(sessionId) {
      if (typeof fetch !== 'function') throw new Error('当前环境不支持网络请求')
      const base = (typeof window !== 'undefined' && typeof window.location === 'object' && window.location !== null
        && typeof window.location.origin === 'string' && window.location.origin !== '' && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://dsh.internal'
      const url = new URL('/api/session.export', base)
      url.searchParams.set('sessionId', String(sessionId))
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = setTimeout(() => { controller?.abort() }, 60000)
      try {
        const response = await fetch(url.toString(), { method: 'GET', signal: controller?.signal ?? undefined })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const buffer = await response.arrayBuffer()
        return new Uint8Array(buffer)
      } finally {
        clearTimeout(timer)
      }
    },
    /** 官方 history RPC 逐页后台拉取 → 完整转写 { lines, turns, atSeq, error }。
     * 经宿主适配层 session/page(契约见 host-adapter.mjs);throughSeq 必须 ≤ 日志尾 seq。 */
    async captureTranscript(sessionId) {
      const handle = connectionSvc
      if (handle === null || handle === undefined || typeof handle?.rpc?.call !== 'function') {
        return { lines: [], turns: 0, atSeq: null, error: 'history 接口不可用(connection.rpc 缺失)' }
      }
      // 当前尾 seq:会话绑定的事件窗口最后一条(窗口未打开时无)。
      let tailSeq = null
      try {
        const eventSource = sessionsSvc?.binding?.(sessionId)?.eventSource ?? null
        tailSeq = windowTailSeqFromEntries(eventSource?.getSnapshot?.()?.entries ?? null)
      } catch {
        // 忽略:走下方显式报错
      }
      if (tailSeq === null) return { lines: [], turns: 0, atSeq: null, error: '无法取得会话尾 seq(会话窗口未打开)' }
      const records = []
      let beforeSeq
      try {
        for (let i = 0; i < 200; i++) {
          const payload = buildSessionPageRequest(sessionId, {
            throughSeq: tailSeq,
            maxMessages: 50,
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
          })
          const response = await withTimeout(handle.rpc.call('/api', 'session/page', { args: payload }), 15000, undefined)
          if (response === undefined) throw new Error('history 请求超时')
          const page = readSessionPageResponse(response)
          if (page.error !== null) throw new Error(page.error)
          if (page.records.length === 0) break
          records.unshift(...page.records)
          if (page.hasMore !== true) break
          const firstEvent = page.records[0]?.event
          if (firstEvent === null || firstEvent === undefined || typeof firstEvent.seq !== 'number') break
          beforeSeq = firstEvent.seq
        }
      } catch (cause) {
        console.warn('[gal-view:save] captureTranscript 拉取失败:', cause)
        return { lines: [], turns: 0, atSeq: null, error: String(cause?.message ?? cause) }
      }
      const result = wireEventsToLines(records)
      return { lines: result.lines, turns: result.turns, atSeq: result.atSeq, error: null }
    },
    /** 存档互斥锁(全局:自动存档与手动存档共用)。 */
    tryLockSave() {
      if (saveLocked) return false
      saveLocked = true
      return true
    },
    unlockSave() {
      saveLocked = false
    },
    /**
     * 执行一次存档(全局统一入口,手动/自动共用):
     * ① 完整转写(history RPC;不可用时回退调用方提供的窗口行);
     * ② (手动档)后台导出官方完整日志 zip——**自动档跳过(skipZip)**:导出端点在
     *    主机侧触发会话日志持久化屏障(sessions.flush),自动档纯后台无法锁定用户输入,
     *    若新回合恰在此窗口开始会与活跃回合交互,曾引发官方窗口重装(对话消失);
     * ③ 一致性守卫(导出前 + 导出后各一次,guardCheck 返回会话 id/回合数);
     * ④ 写 zip+md(含自动档清理/回滚)。
     * @param opts.auto - 是否自动档
     * @param opts.skipZip - true 时不调用导出端点(自动档使用,记录=完整文本转写)
     * @param opts.guardCheck - async () => { sessionId, turns } 当前状态(守卫比对)
     * @param opts.fallbackLines - captureTranscript 不可用时回退的窗口采集(null 则失败)
     */
    async performFileSave(opts = {}) {
      if (!this.tryLockSave()) return { ok: false, reason: 'busy' }
      try {
        const sessionId = this.currentSessionId()
        if (sessionId === null) return { ok: false, reason: 'no-session' }
        const transcript = await this.captureTranscript(sessionId)
        let lines
        let turns
        let atSeq
        let captureNote = ''
        if (transcript.error === null) {
          lines = transcript.lines
          turns = transcript.turns
          atSeq = transcript.atSeq
        } else if (opts.fallbackLines !== null && opts.fallbackLines !== undefined) {
          lines = opts.fallbackLines.lines
          turns = opts.fallbackLines.turns
          atSeq = opts.fallbackLines.atSeq
          captureNote = 'history 接口不可用(' + transcript.error + '),记录为窗口转写'
        } else {
          return { ok: false, reason: 'capture-unavailable: ' + transcript.error }
        }
        if (atSeq === null) {
          // history 转写失败且窗口回退也没有存档点时,把真实原因透传给界面,
          // 而不是一律伪装成「还没有已完成对话」——那是用户反复看到误导提示的根源。
          if (transcript.error !== null) {
            return { ok: false, reason: 'empty;history 转写不可用(' + transcript.error + ')且窗口转写无存档点' }
          }
          return { ok: false, reason: 'empty' }
        }
        const guardBefore = { sessionId, turns }
        const rootTitle = this.mainTitle()
        // 一致性守卫(导出前):若会话已变化,根本不去碰导出端点。
        const checkGuard = async () => {
          const now = await opts.guardCheck()
          return now !== null && now !== undefined && now.sessionId === guardBefore.sessionId && now.turns === guardBefore.turns
        }
        let zip = null
        let exportNote = captureNote
        if (opts.skipZip === true) {
          // 自动档:无导出(零 flush)。快照(台词+存档点)在采集瞬间即一致,
          // 之后完成的回合不影响快照正确性——不套用守卫,否则间隔=1 时
          // 快速连续回合会互相取消、自动档永远存不下来。
          exportNote = (exportNote === '' ? '' : exportNote + ';') + '自动档为完整文本记录(不含官方日志 zip)'
        } else {
          // 手动档:导出端点在主机侧触发日志持久化屏障,导出前后各做一次守卫,
          // 会话变化则中止(绝不产出不一致存档)。
          if (typeof opts.guardCheck === 'function' && !(await checkGuard())) {
            console.warn('[gal-view:save] 存档前会话已变化,中止:', guardBefore)
            return { ok: false, reason: 'interfered' }
          }
          try {
            zip = await this.exportSessionLog(sessionId)
          } catch (cause) {
            console.warn('[gal-view:save] 官方日志导出失败:', cause)
            exportNote = (exportNote === '' ? '' : exportNote + ';') + '官方日志导出失败,记录为文本转录'
          }
          if (typeof opts.guardCheck === 'function' && !(await checkGuard())) {
            console.warn('[gal-view:save] 存档期间对话发生变化,中止:', guardBefore)
            return { ok: false, reason: 'interfered' }
          }
        }
        const result = await this.saveSlotFile({
          auto: opts.auto === true,
          rootTitle,
          sessionId,
          atSeq,
          assistantName: this.assistantName?.() ?? '',
          turns,
          lines,
          complete: true,
          zip,
          exportNote,
          // 手动档由调用方在手势内提前解析目录(权限/选择框只能由手势触发);
          // 这里透传,避免 10 秒导出后脱离手势再解析被浏览器拒绝。
          dir: opts.dir ?? null,
        })
        this.noteSaveOp()
        return { ok: true, ...result }
      } finally {
        this.unlockSave()
        // 操作后检查对话窗口完整性(被官方重装截断时自动恢复)。
        void this.checkConversationIntegrity()
      }
    },
    /** 旧式槽迁移为新式文件存档(标题加"旧",md 正文用 history 转写;尽力导出 zip)。
     * onProgress(done, total) 汇报进度;完成后清空旧槽名录(面板"旧式存档"分区消失)。 */
    async migrateLegacySlots(onProgress) {
      const reg = this.readSlotsRegistry()
      const legacy = [...reg.saves, ...reg.autos]
      if (legacy.length === 0) return { migrated: 0 }
      const dir = await resolveSaveDir()
      if (dir === null) {
        const error = new Error('首次使用需要授权存档文件夹')
        error.code = 'dir-unauthorized'
        throw error
      }
      let done = 0
      for (const slot of legacy) {
        const id = '旧' + slot.id
        const name = id + '.md'
        const zipName = id + '.zip'
        const existingMd = await readSaveFile(dir, name)
        if (existingMd === null) {
          const transcript = await this.captureTranscript(slot.id)
          const lines = transcript.error === null ? transcript.lines : []
          const turns = transcript.error === null ? transcript.turns : 0
          let zip = null
          try { zip = await this.exportSessionLog(slot.id) } catch { /* 归档槽导出失败可接受 */ }
          const text = buildSaveDoc({
            title: '旧' + slot.title,
            savedAt: typeof slot.updatedAt === 'number' ? slot.updatedAt : Date.now(),
            rootTitle: reg.rootTitle,
            sessionId: slot.id,
            atSeq: null,
            assistantName: '',
            turns,
            auto: false,
            legacySlotId: slot.id,
            lines,
            note: '由旧式会话槽迁移;读档走原会话槽路径;完整内容见同名 zip',
          })
          if (zip !== null) await writeSaveZip(dir, zipName, zip)
          try {
            await writeSaveFile(dir, name, text)
          } catch (cause) {
            if (zip !== null) { try { await removeSaveFile(dir, zipName) } catch { /* 忽略 */ } }
            throw cause
          }
          console.info('[gal-view:save] 旧档迁移:', name)
        }
        done += 1
        if (typeof onProgress === 'function') onProgress(done, legacy.length)
      }
      reg.saves = []
      reg.autos = []
      this.writeSlotsRegistry(reg)
      void this.checkConversationIntegrity()
      return { migrated: done }
    },
    /** 当前工程路径(会话 cwd;缺失返回空串)。 */
    projectPath() {
      const snapshot = sessionsSvc?.list?.getSnapshot?.() ?? null
      const current = sessionOf(snapshot)
      if (current === null) return ''
      const cwd = snapshot?.byId?.[current]?.cwd
      return typeof cwd === 'string' ? cwd : ''
    },
    /** 存档目录信息:{ supported, authorized, dirName, projectPath, mismatch }。
     * dirName=已授权工程文件夹名;mismatch=授权目录与当前工程路径不一致。 */
    async saveDirInfo() {
      const supported = fsAccessSupported()
      let dirName = ''
      let authorized = false
      if (supported) {
        const handle = await loadDirHandle()
        if (handle !== null && handle !== undefined) {
          authorized = true
          dirName = typeof handle.name === 'string' ? handle.name : ''
        }
      }
      const projectPath = this.projectPath()
      const pathBase = String(projectPath).split(/[\\/]/).filter(Boolean).pop() ?? ''
      const mismatch = authorized && dirName !== '' && pathBase !== '' && dirName !== pathBase
      return { supported, authorized, dirName, projectPath, mismatch }
    },
    /** 当前 AI 名牌(存档记录用)。 */
    assistantName() {
      return assistantDisplayName(sceneSource.getSnapshot())
    },
    /** 对话栏完整性检查(操作后自动调用):官方窗口可能因瞬时序列断档被重装成
     * 不完整尾部(早前对话从「对话」栏消失)。
     * 上游 v0.1.2 加固:本函数**只记录、绝不干预**——新运行时自带 torn-tail
     * 修复与窗口 replace 机制,我们对它的触发语义没有完整理解,任何 resync/
     * 重装原语都可能再次成为"对话消失"的共犯(历史教训:看门狗只记录不干预)。
     * 检测到疑似截断时仅输出可读日志供诊断。返回 false 恒成立(未执行恢复)。 */
    async checkConversationIntegrity() {
      const id = this.currentSessionId()
      if (id === null) return false
      const listSnap = sessionsSvc?.list?.getSnapshot?.() ?? null
      const entry = listSnap !== null && listSnap.byId?.[id] !== undefined ? listSnap.byId[id] : null
      if (entry?.running === true) return false
      const session = sessionsSvc?.binding?.(id)?.session ?? null
      if (session === null) return false
      try {
        const transcript = await this.captureTranscript(id)
        if (transcript.error !== null || transcript.atSeq === null) return false
        const events = Array.isArray(session.events) ? session.events : null
        const windowTail = events !== null && events.length > 0 && typeof events[events.length - 1]?.seq === 'number'
          ? events[events.length - 1].seq
          : null
        if (windowTail === null) return false
        if (transcript.atSeq - windowTail > 8) {
          // 只记录:曾在这里调用 session.resync() 重装窗口,该干预在新运行时
          // (窗口 replace/官方尾部修复)语义未知,已移除——绝不主动触碰官方窗口。
          console.warn('[gal-view:watchdog] 检测到对话窗口可能被截断(持久尾部 ' + transcript.atSeq + ' vs 窗口尾部 ' + windowTail + ')。仅记录不干预;如对话确实缺失,请刷新页面或向 dsh-desktop 反馈。')
        }
      } catch (cause) {
        console.warn('[gal-view:watchdog] 完整性检查失败:', cause)
      }
      return false
    },
}

}
