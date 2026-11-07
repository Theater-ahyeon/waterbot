import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { z } from 'zod'

import { HttpError } from './http'

export interface GithubRepo {
  full_name: string
  description: string | null
  html_url: string
  stargazers_count: number
  default_branch: string
  private: boolean
}

export interface GithubIssue {
  number: number
  title: string
  state: string
  html_url: string
  user: string
  created_at: string
  updated_at: string
  pull_request: boolean
}

interface GithubOptions {
  baseUrl?: string
  token?: string
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/
const MAX_ISSUES = 50

const RepoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable().optional(),
  html_url: z.string(),
  stargazers_count: z.number().optional(),
  default_branch: z.string().optional(),
  private: z.boolean().optional(),
})

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
})

function nameField(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) throw new HttpError(400, `${field}无效`)
  return value
}

export class GithubService {
  private readonly baseUrl: string

  constructor(private readonly options: GithubOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  }

  status(): { configured: boolean; authenticated: boolean; baseUrl: string } {
    return { configured: true, authenticated: !!this.options.token, baseUrl: this.baseUrl }
  }

  async repo(owner: string, repo: string): Promise<GithubRepo> {
    const value = await this.get(`/repos/${encodeURIComponent(nameField(owner, '仓库所有者'))}/${encodeURIComponent(nameField(repo, '仓库名'))}`)
    const parsed = RepoSchema.safeParse(value)
    if (!parsed.success) throw new HttpError(502, 'GitHub 返回格式无效')
    const data = parsed.data
    return {
      full_name: data.full_name,
      description: data.description ?? null,
      html_url: data.html_url,
      stargazers_count: data.stargazers_count ?? 0,
      default_branch: data.default_branch ?? '',
      private: data.private === true,
    }
  }

  async issues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GithubIssue[]> {
    if (state !== 'open' && state !== 'closed' && state !== 'all') throw new HttpError(400, 'issue 状态无效')
    const value = await this.get(
      `/repos/${encodeURIComponent(nameField(owner, '仓库所有者'))}/${encodeURIComponent(nameField(repo, '仓库名'))}/issues?state=${state}&per_page=${MAX_ISSUES}`,
    )
    if (!Array.isArray(value)) throw new HttpError(502, 'GitHub 返回格式无效')
    return value.slice(0, MAX_ISSUES).map((item, index): GithubIssue => {
      const parsed = IssueSchema.safeParse(item)
      if (!parsed.success) throw new HttpError(502, `GitHub 返回格式无效：第 ${index + 1} 条 issue`)
      const issue = parsed.data
      return {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        html_url: issue.html_url,
        user: issue.user?.login ?? '',
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        pull_request: issue.pull_request !== undefined,
      }
    })
  }

  private async get(path: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'waterbot/0.1',
          ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      throw new HttpError(502, `GitHub 请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200)
      throw new HttpError(502, `GitHub 返回 ${response.status}${body ? `：${body}` : ''}`)
    }
    try {
      return await response.json()
    } catch {
      throw new HttpError(502, 'GitHub 返回格式无效')
    }
  }
}

export function createGithubTools(github: GithubService): ToolRegistration[] {
  const output = (value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value).slice(0, 20_000) }]
  return [
    defineTool({
      name: 'github_read_repo',
      description: 'Read public GitHub repository metadata by owner and repository name. Read-only.',
      parameters: Type.Object({ owner: Type.String(), repo: Type.String() }),
      replay: 'safe',
      execute: async (args) => ({ output: output(await github.repo(args.owner, args.repo)) }),
    }),
    defineTool({
      name: 'github_list_issues',
      description: 'List up to 50 GitHub issues and pull requests for a repository. Read-only.',
      parameters: Type.Object({
        owner: Type.String(), repo: Type.String(),
        state: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed'), Type.Literal('all')])),
      }),
      replay: 'safe',
      execute: async (args) => ({ output: output(await github.issues(args.owner, args.repo, args.state ?? 'open')) }),
    }),
  ]
}
