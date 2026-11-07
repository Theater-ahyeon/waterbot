import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from '../test/integration/database'
import { ExecutionService } from './execution'
import { readAudioBody, VoiceService } from './voice'

describe('语音转写与合成（本地夹具 / 真实 PG）', () => {
  let db: TestDatabase
  let dir: string
  let fixture: Server
  let voice: VoiceService
  let execution: ExecutionService
  let profile = ''

  beforeAll(async () => {
    db = await createTestDatabase(inject('pgAdminUrl'))
    dir = await mkdtemp(join(tmpdir(), 'pa-voice-'))
    profile = '77777777-7777-4777-8777-777777777777'
    await db.pool.query('insert into profile(id,name,instructions) values ($1,$2,$3)', [profile, '语音测试', '测试'])
    fixture = createServer((request, response) => {
      if (request.url === '/stt' && request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ text: '转写结果' }))
        return
      }
      if (request.url === '/tts' && request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'audio/mpeg' })
        response.end(Buffer.from('ID3fake-mp3-data'))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((ready) => fixture.listen(0, '127.0.0.1', ready))
    const address = fixture.address()
    if (!address || typeof address === 'string') throw new Error('fixture 未启动')
    const base = `http://127.0.0.1:${address.port}`
    voice = new VoiceService(db.pool, join(dir, 'voice'), {
      sttUrl: `${base}/stt`, ttsUrl: `${base}/tts`, sttModel: 'whisper-test', ttsModel: 'tts-test', ttsVoice: 'voice-test',
    })
    execution = new ExecutionService(db.pool, join(dir, 'workspaces'), join(dir, 'worker.mjs'), [join(dir, 'voice')])
  })

  afterAll(async () => {
    await new Promise<void>((done) => fixture?.close(() => done()))
    await db?.dispose()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('转写音频并返回文本', async () => {
    expect(voice.status()).toEqual({ configured: true, stt: true, tts: true })
    expect(await voice.transcribe(profile, Buffer.from('fake-audio'), 'voice.webm', 'audio/webm')).toBe('转写结果')
  })

  it('合成音频、写入产物并可下载', async () => {
    const artifact = await voice.speak(profile, '你好，这是语音。')
    expect(artifact.mime).toBe('audio/mpeg')
    expect((await readFile(artifact.storage_path)).toString()).toBe('ID3fake-mp3-data')
    const download = await execution.downloadPath(artifact.id)
    expect(download.path).toBe(artifact.storage_path)
  })

  it('未配置时明确失败，原始音频有大小上限', async () => {
    const disabled = new VoiceService(db.pool, join(dir, 'unused'), {})
    expect(disabled.status()).toEqual({ configured: false, stt: false, tts: false })
    await expect(disabled.transcribe(profile, Buffer.from('x'), 'a.webm', 'audio/webm')).rejects.toThrow('未配置')
    await expect(disabled.speak(profile, '文本')).rejects.toThrow('未配置')

    async function* chunks() {
      yield Buffer.alloc(4)
      yield Buffer.alloc(4)
    }
    await expect(readAudioBody(chunks(), 6)).rejects.toThrow('音频文件过大')
  })
})
