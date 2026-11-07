import { describe, expect, it } from 'vitest'

import { loadConfig } from './config'
import { originForRequest } from './http'

describe('请求来源校验', () => {
  it('默认只接受本机 Host', () => {
    expect(originForRequest('127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(originForRequest('localhost:8787')).toBe('http://localhost:8787')
    expect(() => originForRequest('waterbot.example.com')).toThrow('只允许本机')
    expect(() => originForRequest(undefined)).toThrow('来源无效')
  })

  it('配置反向代理地址后只接受该主机', () => {
    expect(originForRequest('waterbot.example.com', 'https://waterbot.example.com'))
      .toBe('https://waterbot.example.com')
    expect(() => originForRequest('other.example.com', 'https://waterbot.example.com'))
      .toThrow('只允许本机')
    expect(originForRequest('127.0.0.1:8787', 'https://waterbot.example.com'))
      .toBe('http://127.0.0.1:8787')
  })
})

describe('PUBLIC_ORIGIN 配置', () => {
  it('只保存协议和主机', () => {
    expect(loadConfig({ PUBLIC_ORIGIN: 'https://waterbot.example.com/' }).publicOrigin)
      .toBe('https://waterbot.example.com')
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://127.0.0.1:8787' }).publicOrigin)
      .toBe('http://127.0.0.1:8787')
  })

  it('拒绝带路径、凭据或非 http 协议的值', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://waterbot.example.com/app' })).toThrow('协议和主机')
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://user:pass@waterbot.example.com' })).toThrow('协议和主机')
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'ftp://waterbot.example.com' })).toThrow('协议和主机')
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'not a url' })).toThrow('PUBLIC_ORIGIN')
  })

  it('数据根目录会原样保留，由启动入口解析', () => {
    expect(loadConfig({ WATERBOT_DATA_DIR: '/var/lib/waterbot' }).dataDirectory).toBe('/var/lib/waterbot')
  })
})
