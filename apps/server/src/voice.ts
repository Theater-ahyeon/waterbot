import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { HttpError } from './http'
import type { Pool } from './pg/connection'

export interface VoiceStatus {
  configured: boolean
  stt: boolean
  tts: boolean
}

export interface VoiceArtifact {
  id: string
  name: string
  mime: string
  size: string
  storage_path: string
}

interface VoiceOptions {
  sttUrl?: string
  sttModel?: string
  ttsUrl?: string
  ttsModel?: string
  ttsVoice?: string
  apiKey?: string
}

export class VoiceService {
  constructor(
    private readonly pool: Pool,
    private readonly root: string,
    private readonly options: VoiceOptions = {},
  ) {}

  status(): VoiceStatus {
    return { configured: !!(this.options.sttUrl || this.options.ttsUrl), stt: !!this.options.sttUrl, tts: !!this.options.ttsUrl }
  }

  async transcribe(_profileId: string, data: Buffer, filename: string, mime: string): Promise<string> {
    if (!this.options.sttUrl) throw new HttpError(503, '语音转写未配置')
    if (!data.length) throw new HttpError(400, '音频为空')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename)
    form.append('model', this.options.sttModel ?? 'whisper-1')
    let response: Response
    try {
      response = await fetch(this.options.sttUrl, {
        method: 'POST',
        headers: this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
    } catch (error) {
      throw new HttpError(502, `语音转写请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) throw new HttpError(502, `语音转写返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`)
    try {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') {
        throw new Error('text required')
      }
      return value.text
    } catch {
      throw new HttpError(502, '语音转写返回格式无效')
    }
  }

  async speak(profileId: string, text: string): Promise<VoiceArtifact> {
    if (!this.options.ttsUrl) throw new HttpError(503, '语音合成未配置')
    if (!(await this.pool.query('select 1 from profile where id = $1', [profileId])).rowCount) throw new HttpError(404, '人格不存在')
    let response: Response
    try {
      response = await fetch(this.options.ttsUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.ttsModel ?? 'tts-1',
          voice: this.options.ttsVoice ?? 'alloy',
          input: text,
          response_format: 'mp3',
        }),
        signal: AbortSignal.timeout(120_000),
      })
    } catch (error) {
      throw new HttpError(502, `语音合成请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      throw new HttpError(502, `语音合成返回 ${response.status}${detail ? `：${detail}` : ''}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new HttpError(502, '语音合成返回空内容')
    const directory = join(this.root, profileId)
    await mkdir(directory, { recursive: true })
    const name = `voice-${Date.now()}-${randomUUID().slice(0, 8)}.mp3`
    const path = join(directory, name)
    await writeFile(path, buffer)
    const id = randomUUID()
    const artifact = (await this.pool.query<VoiceArtifact>(
      `insert into artifact(id, profile_id, execution_id, name, relative_path, mime, size, sha256, storage_path)
       values ($1,$2,null,$3,$3,'audio/mpeg',$4,$5,$6)
       returning id, name, mime, size::text, storage_path`,
      [id, profileId, name, String(buffer.length), createHash('sha256').update(buffer).digest('hex'), path],
    )).rows[0]!
    return artifact
  }
}

/** 读取原始音频请求体；超过限额直接 413，不把半截音频交给转写。 */
export async function readAudioBody(request: AsyncIterable<Buffer | string>, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new HttpError(413, '音频文件过大')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
