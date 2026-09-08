import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  addAssignees,
  Context,
  Fetch,
  getOctokit,
  getRepositoryContent,
  GitHubApiError,
  listPullRequestFiles,
  requestReviewers,
} from '../src/github'

function jsonResponse(
  data: unknown,
  options: { status?: number; statusText?: string; headers?: HeadersInit } = {}
): Response {
  return new Response(data === undefined ? undefined : JSON.stringify(data), {
    status: options.status ?? 200,
    statusText: options.statusText,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
}

describe('Context', () => {
  const environment = { ...process.env }
  let directory: string | undefined

  beforeEach(() => {
    process.env = { ...environment }
  })

  afterEach(() => {
    process.env = { ...environment }
    if (directory) rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  function writeEvent(payload: unknown): string {
    directory = mkdtempSync(join(tmpdir(), 'auto-assign-context-'))
    const eventPath = join(directory, 'event.json')
    writeFileSync(eventPath, JSON.stringify(payload))
    return eventPath
  }

  test('hydrates the event payload and action context from the environment', () => {
    const eventPath = writeEvent({
      pull_request: { number: 42 },
      repository: { name: 'payload-repo', owner: { login: 'payload-owner' } },
    })
    Object.assign(process.env, {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'environment-owner/environment-repo',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_SHA: 'abc123',
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_API_URL: 'https://github.example/api/v3',
      GITHUB_SERVER_URL: 'https://github.example',
      GITHUB_GRAPHQL_URL: 'https://github.example/api/graphql',
      GITHUB_JOB: 'assign',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_NUMBER: '3',
      GITHUB_RUN_ID: '4',
    })

    const context = new Context()

    expect(context.payload.pull_request?.number).toBe(42)
    expect(context.repo).toEqual({
      owner: 'environment-owner',
      repo: 'environment-repo',
    })
    expect(context.issue).toEqual({
      owner: 'environment-owner',
      repo: 'environment-repo',
      number: 42,
    })
    expect(context.eventName).toBe('pull_request')
    expect(context.sha).toBe('abc123')
    expect(context.ref).toBe('refs/pull/42/merge')
    expect(context.apiUrl).toBe('https://github.example/api/v3')
    expect(context.serverUrl).toBe('https://github.example')
    expect(context.graphqlUrl).toBe('https://github.example/api/graphql')
    expect(context.job).toBe('assign')
    expect(context.runAttempt).toBe(2)
    expect(context.runNumber).toBe(3)
    expect(context.runId).toBe(4)
  })

  test('falls back to repository data in the event payload', () => {
    delete process.env.GITHUB_REPOSITORY
    process.env.GITHUB_EVENT_PATH = writeEvent({
      number: 7,
      repository: { name: 'payload-repo', owner: { login: 'payload-owner' } },
    })

    const context = new Context()

    expect(context.repo).toEqual({
      owner: 'payload-owner',
      repo: 'payload-repo',
    })
    expect(context.issue.number).toBe(7)
  })
})

describe('GitHub OpenAPI client', () => {
  test('gets encoded repository content with GitHub API headers on GHES', async () => {
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(async () =>
      jsonResponse({ content: 'Y29uZmln', encoding: 'base64', type: 'file' })
    )
    const client = getOctokit('secret-token', {
      baseUrl: 'https://github.example/api/v3/',
      fetch: fetchMock,
    })

    const response = await getRepositoryContent(client, {
      owner: 'test owner',
      repo: 'repo#1',
      path: '.github/config file#.yml',
      ref: 'refs/heads/main',
    })

    expect(Array.isArray(response.data)).toBe(false)
    const request = fetchMock.mock.calls[0][0]
    expect(request.url).toBe(
      'https://github.example/api/v3/repos/test%20owner/repo%231/contents/.github/config%20file%23.yml?ref=refs%2Fheads%2Fmain'
    )
    expect(request.method).toBe('GET')
    expect(request.headers.get('Accept')).toBe('application/vnd.github+json')
    expect(request.headers.get('Authorization')).toBe('Bearer secret-token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
    expect(request.headers.get('User-Agent')).toBe('auto-assign-action')
    expect(request.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28')
  })

  test('posts reviewer and assignee request bodies to typed endpoints', async () => {
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(async () =>
      jsonResponse({ id: 1 }, { status: 201 })
    )
    const client = getOctokit('token', { fetch: fetchMock })

    await requestReviewers(client, {
      owner: 'owner',
      repo: 'repo',
      pull_number: 12,
      reviewers: ['reviewer-a', 'reviewer-b'],
    })
    await addAssignees(client, {
      owner: 'owner',
      repo: 'repo',
      issue_number: 12,
      assignees: ['assignee-a'],
    })

    expect(fetchMock.mock.calls[0][0].url).toBe(
      'https://api.github.com/repos/owner/repo/pulls/12/requested_reviewers'
    )
    expect(fetchMock.mock.calls[0][0].method).toBe('POST')
    await expect(fetchMock.mock.calls[0][0].json()).resolves.toEqual({
      reviewers: ['reviewer-a', 'reviewer-b'],
    })
    expect(fetchMock.mock.calls[1][0].url).toBe(
      'https://api.github.com/repos/owner/repo/issues/12/assignees'
    )
    await expect(fetchMock.mock.calls[1][0].json()).resolves.toEqual({
      assignees: ['assignee-a'],
    })
  })

  test('follows the exact same-origin rel=next URL, including a renamed route', async () => {
    const fetchMock = jest
      .fn<ReturnType<Fetch>, Parameters<Fetch>>()
      .mockResolvedValueOnce(
        jsonResponse([{ filename: 'first.ts' }], {
          headers: {
            Link: '<https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2>; rel="last"',
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([
          { filename: 'second.ts', previous_filename: 'renamed.ts' },
        ])
      )
    const client = getOctokit('token', { fetch: fetchMock })

    const files = await listPullRequestFiles(client, {
      owner: 'owner',
      repo: 'repo',
      pull_number: 2,
      per_page: 100,
    })

    expect(files).toEqual([
      { filename: 'first.ts' },
      { filename: 'second.ts', previous_filename: 'renamed.ts' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0].url).toBe(
      'https://api.github.com/repos/owner/repo/pulls/2/files?per_page=100'
    )
    expect(fetchMock.mock.calls[1][0].url).toBe(
      'https://api.github.com/repositories/1/pulls/2/files?per_page=100&page=2'
    )
    expect(fetchMock.mock.calls[1][0].headers.get('Authorization')).toBe(
      'Bearer token'
    )
  })

  test('resolves relative pagination links within a GHES API base path', async () => {
    const fetchMock = jest
      .fn<ReturnType<Fetch>, Parameters<Fetch>>()
      .mockResolvedValueOnce(
        jsonResponse([], {
          headers: {
            Link: '<repositories/1/pulls/2/files?page=2>; rel="next"',
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse([]))
    const client = getOctokit('token', {
      baseUrl: 'https://github.example/api/v3',
      fetch: fetchMock,
    })

    await listPullRequestFiles(client, {
      owner: 'owner',
      repo: 'repo',
      pull_number: 2,
    })

    expect(fetchMock.mock.calls[1][0].url).toBe(
      'https://github.example/api/v3/repositories/1/pulls/2/files?page=2'
    )
  })

  test('throws a structured error for a non-successful GitHub response', async () => {
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(async () =>
      jsonResponse(
        {
          message: 'Validation Failed',
          documentation_url: 'https://docs.github.com/rest',
        },
        {
          status: 422,
          statusText: 'Unprocessable Entity',
          headers: { 'x-github-request-id': 'request-id' },
        }
      )
    )
    const client = getOctokit('token', { fetch: fetchMock })

    let error: unknown
    try {
      await requestReviewers(client, {
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        reviewers: ['unknown'],
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(GitHubApiError)
    expect(error).toEqual(
      expect.objectContaining({
        message: 'Validation Failed - https://docs.github.com/rest',
        status: 422,
      })
    )
    expect((error as GitHubApiError).response.data).toEqual(
      expect.objectContaining({ message: 'Validation Failed' })
    )
    expect(
      (error as GitHubApiError).response.headers.get('x-github-request-id')
    ).toBe('request-id')
  })

  test('uses a fallback structured error for an undocumented empty error body', async () => {
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(
      async () =>
        new Response(undefined, { status: 500, statusText: 'Server Error' })
    )
    const client = getOctokit('token', { fetch: fetchMock })

    await expect(
      listPullRequestFiles(client, {
        owner: 'owner',
        repo: 'repo',
        pull_number: 2,
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'GitHubApiError',
        message: 'GitHub API request failed: 500 Server Error',
        status: 500,
      })
    )
  })

  test('refuses to send credentials to a cross-origin pagination link', async () => {
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(async () =>
      jsonResponse([], {
        headers: { Link: '<https://attacker.example/page/2>; rel="next"' },
      })
    )
    const client = getOctokit('token', { fetch: fetchMock })

    await expect(
      listPullRequestFiles(client, {
        owner: 'owner',
        repo: 'repo',
        pull_number: 2,
        per_page: 100,
      })
    ).rejects.toThrow('Refusing to follow pagination link')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('detects pagination loops before repeating a request', async () => {
    const repeatedUrl =
      'https://api.github.com/repositories/1/pulls/2/files?page=2'
    const fetchMock = jest
      .fn<ReturnType<Fetch>, Parameters<Fetch>>()
      .mockResolvedValueOnce(
        jsonResponse([], {
          headers: { Link: `<${repeatedUrl}>; rel="next"` },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse([], {
          headers: { Link: `<${repeatedUrl}>; rel="next"` },
        })
      )
    const client = getOctokit('token', { fetch: fetchMock })

    await expect(
      listPullRequestFiles(client, {
        owner: 'owner',
        repo: 'repo',
        pull_number: 2,
      })
    ).rejects.toThrow('GitHub API pagination loop detected')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('propagates native fetch network errors unchanged', async () => {
    const networkError = new TypeError('fetch failed')
    const fetchMock = jest.fn<ReturnType<Fetch>, Parameters<Fetch>>(
      async () => {
        throw networkError
      }
    )
    const client = getOctokit('token', { fetch: fetchMock })

    await expect(
      getRepositoryContent(client, {
        owner: 'owner',
        repo: 'repo',
        path: 'file',
      })
    ).rejects.toBe(networkError)
  })
})
