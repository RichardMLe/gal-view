// 状态持久化分层约定(架构前提步骤③-2,规范附录 C)测试:
// 键/库名集中登记、命名空间、版本常量。
import test from 'node:test'
import assert from 'node:assert/strict'
import { LS_KEYS, IDB_NAMES, PERSIST_LAYERS, SLOTS_VERSION } from '../.dsh-plugin/client/persist.mjs'

test('LS_KEYS:全部 localStorage 键 gal-view: 前缀集中登记', () => {
  for (const [name, key] of Object.entries(LS_KEYS)) {
    assert.ok(key.startsWith('gal-view:'), name + ' 必须以 gal-view: 开头: ' + key)
  }
  assert.equal(LS_KEYS.scene, 'gal-view:scene:v1')
  assert.equal(LS_KEYS.slots, 'gal-view:slots')
  assert.equal(LS_KEYS.readPrefix, 'gal-view:read')
  assert.equal(LS_KEYS.autoPrefix, 'gal-view:auto')
})

test('IDB_NAMES:库/表名集中登记', () => {
  assert.equal(IDB_NAMES.assetsDb, 'gal-view')
  assert.equal(IDB_NAMES.assetsStore, 'assets')
  assert.equal(IDB_NAMES.fontsDb, 'gal-view')
  assert.equal(IDB_NAMES.fontsStore, 'fonts')
  assert.equal(IDB_NAMES.fsDb, 'gal-view-fs')
})

test('PERSIST_LAYERS:四层登记表齐备(新增状态必须登记)', () => {
  assert.ok(Array.isArray(PERSIST_LAYERS.machine) && PERSIST_LAYERS.machine.length > 0)
  assert.ok(Array.isArray(PERSIST_LAYERS.project) && PERSIST_LAYERS.project.length > 0)
  assert.ok(Array.isArray(PERSIST_LAYERS.session) && PERSIST_LAYERS.session.length > 0)
  assert.ok(Array.isArray(PERSIST_LAYERS.memory) && PERSIST_LAYERS.memory.length > 0)
  assert.ok(PERSIST_LAYERS.machine.every(e => e.includes('LS_KEYS') || e.includes('IDB')))
})

test('SLOTS_VERSION:正整数版本', () => {
  assert.equal(SLOTS_VERSION, 1)
})
