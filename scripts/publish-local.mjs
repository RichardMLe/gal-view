// 发布一条命令(A7):测试 → 构建 → 仿真 → 写回已装插件 → MD5 核验。
// 用法(需升级权限,写工作区外):
//   pwsh -Command "node scripts/publish-local.mjs"
// 任一步失败即中止并返回非零。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const built = path.join(root, '.dsh-plugin', 'client.js')
const installs = [
  'C:\\Users\\11488\\.dsh\\profiles\\web\\node_modules\\gal-view\\.dsh-plugin\\client.js',
  'C:\\Users\\11488\\.dsh\\profiles\\web\\node_modules\\gal-view\\client.js',
]

function step(name, cmd, args) {
  console.log('▶ ' + name)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) {
    console.error('✘ ' + name + ' 失败(exit ' + r.status + ')')
    process.exit(1)
  }
  console.log('✔ ' + name)
}

step('单测', process.execPath, ['tests/run.mjs'])
step('构建', process.execPath, ['scripts/build-client.mjs'])
step('仿真', process.execPath, ['verify-bundle.mjs'])

const hash = crypto.createHash('md5').update(fs.readFileSync(built)).digest('hex')
for (const target of installs) {
  fs.copyFileSync(built, target)
  const actual = crypto.createHash('md5').update(fs.readFileSync(target)).digest('hex')
  if (actual !== hash) {
    console.error('✘ 写回核验失败(MD5 不一致): ' + target)
    process.exit(1)
  }
  console.log('✔ 写回+核验: ' + target)
}
console.log('ALL DONE')
