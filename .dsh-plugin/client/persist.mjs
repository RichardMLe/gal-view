// 状态持久化分层约定(架构前提步骤③-2,规范附录 C):
// 所有持久化 key/库名集中登记于此;新增状态必须先在本表登记再写代码。
// 分层:机器级(跨工程共享)/ 工程级(按工程隔离)/ 会话级(按会话隔离)/ 内存态(不持久)。
// 命名空间:localStorage 一律前缀 `gal-view:`;IndexedDB 库名 gal-view / gal-view-fs。

/** localStorage 键(全部前缀 gal-view:)。 */
export const LS_KEYS = Object.freeze({
  /** 槽位注册表(旧式会话槽)。数据实为工程级,key 机器级——已知债 C3,面板按前缀过滤。 */
  slots: 'gal-view:slots',
  /** 场景设置。数据实为工程级,单 key 跨工程共享——已知债 C3。 */
  scene: 'gal-view:scene:v1',
  /** 插件开关(机器级)。 */
  enabled: 'gal-view:enabled',
  /** 编辑器面板偏好(机器级)。 */
  editorPanels: 'gal-view:editor-panels',
  /** 阅读进度前缀(会话级;key = <readPrefix> 或 <readPrefix>.<scopeKey>)。 */
  readPrefix: 'gal-view:read',
  /** 自动存档基线前缀(会话级;key = <autoPrefix>:<sessionId>)。 */
  autoPrefix: 'gal-view:auto',
})

/** IndexedDB 库/表名。 */
export const IDB_NAMES = Object.freeze({
  /** 素材库(机器级,表 assets;图片 dataURL 不进 localStorage)。 */
  assetsDb: 'gal-view',
  assetsStore: 'assets',
  /** 字体库(机器级,表 fonts)。 */
  fontsDb: 'gal-view',
  fontsStore: 'fonts',
  /** 存档目录授权句柄。实为工程级,现单键跨工程——已知债 C4,面板有 mismatch 提示。 */
  fsDb: 'gal-view-fs',
})

/** 持久化分层登记表(代码注释镜像;升级/新增对照本表)。 */
export const PERSIST_LAYERS = Object.freeze({
  machine: [
    'LS_KEYS.enabled(插件开关)',
    'LS_KEYS.editorPanels(编辑器面板偏好)',
    'IDB assets/fonts(素材/字体库,跨工程共享)',
  ],
  project: [
    '场景设置(实为工程级;当前单 key——债 C3)',
    '槽位注册表(实为工程级;当前单 key——债 C3)',
    '存档目录授权句柄(实为工程级;当前单句柄——债 C4)',
  ],
  session: [
    'LS_KEYS.readPrefix.<scopeKey>(阅读进度)',
    'LS_KEYS.autoPrefix:<sessionId>(自动存档基线)',
  ],
  memory: [
    'sceneSource/historySource/assetsSource/fontsSource 等可观察镜像',
    'saveLocked(存档互斥锁)/viewSessionId(视图注入)/autoSaveSource(状态发布)',
  ],
})

/** 槽位注册表版本(读容错、写带上;未来迁移按版本号判断)。 */
export const SLOTS_VERSION = 1
