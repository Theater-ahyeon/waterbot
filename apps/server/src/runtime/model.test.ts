import { describe, expect, it } from 'vitest'

import { createRemoteModels, loadRemoteModelConfig } from './model'

const config = {
  baseUrl: 'http://127.0.0.1:3425/v1',
  apiKey: 'test-key',
  modelId: 'antigravity/gemini-3.8-flash',
  providerId: 'magpie',
}

describe('loadRemoteModelConfig', () => {
  it('未配置任何一项时继续使用 faux', () => {
    expect(loadRemoteModelConfig({})).toBeUndefined()
  })

  it('只配置一部分时直接报错', () => {
    expect(() => loadRemoteModelConfig({ OPENAI_BASE_URL: config.baseUrl })).toThrow('同时设置')
    expect(() => loadRemoteModelConfig({ OPENAI_API_KEY: config.apiKey, MODEL_ID: config.modelId })).toThrow('同时设置')
  })

  it('OPENAI_MODEL 优先于 MODEL_ID', () => {
    const loaded = loadRemoteModelConfig({
      OPENAI_BASE_URL: config.baseUrl,
      OPENAI_API_KEY: config.apiKey,
      OPENAI_MODEL: 'auto/gpt-5.6-luna',
      MODEL_ID: config.modelId,
    })
    expect(loaded?.modelId).toBe('auto/gpt-5.6-luna')
  })

  it('拒绝非 HTTP 地址', () => {
    expect(() => loadRemoteModelConfig({
      OPENAI_BASE_URL: 'file:///tmp/model',
      OPENAI_API_KEY: config.apiKey,
      MODEL_ID: config.modelId,
    })).toThrow('http')
  })
})

describe('createRemoteModels', () => {
  it('注册配置的 OpenAI Completions 模型和真实地址', () => {
    const { models, model, modelInfo } = createRemoteModels(config)
    expect(model).toEqual({ provider: 'magpie', modelId: 'antigravity/gemini-3.8-flash' })
    const found = models.getModel('magpie', 'antigravity/gemini-3.8-flash')
    expect(found?.baseUrl).toBe(config.baseUrl)
    expect(found?.api).toBe('openai-completions')
    expect(modelInfo.contextWindow).toBe(1_048_576)
    expect(modelInfo.maxTokens).toBe(65_536)
  })
})
