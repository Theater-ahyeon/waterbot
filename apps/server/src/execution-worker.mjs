import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const specPath = process.argv[2]
if (!specPath) throw new Error('缺少任务描述文件')
const spec = JSON.parse(await readFile(specPath, 'utf8'))
const resultPath = join(spec.cwd, 'result.json')
const limit = 200_000
let output = ''
let finished = false

const child = spawn(spec.command, {
  cwd: spec.cwd,
  shell: true,
  windowsHide: true,
  env: process.env,
})

const append = (chunk) => {
  if (output.length >= limit) return
  output += String(chunk).slice(0, limit - output.length)
}
child.stdout.on('data', append)
child.stderr.on('data', append)

const timer = setTimeout(() => {
  if (finished) return
  finished = true
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // 进程可能已经退出，任务结果由 close 事件继续处理。
  }
}, spec.timeoutMs ?? 60_000)

child.on('close', async (code) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  await writeFile(resultPath, JSON.stringify({ exitCode: code, output }), 'utf8')
})

child.on('error', async (error) => {
  if (finished) return
  finished = true
  clearTimeout(timer)
  await writeFile(resultPath, JSON.stringify({ exitCode: null, output: `${output}${error.message}` }), 'utf8')
})
