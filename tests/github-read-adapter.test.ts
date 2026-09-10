import { describe, expect, it, vi } from 'vitest'
import { GitHubReadAdapter, GitHubAdapterValidationError, type FetchLike } from '../src/adapters/github-read-adapter'
import type { AdapterExecutionResult, ExecutionContext, Run, Step, Task } from '../src/core/types'
import { createRunner } from '../src/engine/factory'
import { InMemoryRunnerStore } from '../src/persistence/store'
import { deterministicOptions } from './helpers'

const context: ExecutionContext = {
  run_id: 'run-github', step_id: 'step-github', idempotency_key: 'github-operation-key', attempt: 1, is_cancelled: () => false,
}
const input = { operation: 'get_repository', owner: 'octocat', repo: 'Hello-World' }
const repository = {
  id: 1,
  name: 'Hello-World',
  full_name: 'octocat/Hello-World',
  owner: { login: 'octocat' },
  html_url: 'https://github.com/octocat/Hello-World',
  private: false,
  archived: false,
  default_branch: 'master',
  ignored_provider_payload: 'not persisted',
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function adapterWith(result: Response | Error, token?: string) {
  const fakeFetch = vi.fn<FetchLike>(async () => {
    if (result instanceof Error) throw result
    return result
  })
  return { adapter: new GitHubReadAdapter({ fetch: fakeFetch, token, timeoutMs: 5 }), fakeFetch }
}

function githubTask(idempotencyKey = 'github-task-key') {
  return {
    task_id: `task-${idempotencyKey}`,
    type: 'repository.lookup',
    objective: 'Retrieve and verify one explicit GitHub repository',
    input: {
      steps: [{
        tool: 'github.read', action: 'get_repository', input,
        expected_outcome: { full_name: 'octocat/Hello-World', visibility: 'public' }, risk_level: 0,
      }],
    },
    constraints: {}, risk_level: 0 as const, requested_at: '2026-09-10T00:00:00.000Z',
    requested_by: 'test-suite', policy_context: {}, idempotency_key: idempotencyKey,
  }
}

describe('ToolAdapter contract: github.read', () => {
  it('declares one read-only Level 0 capability', () => {
    const adapter = new GitHubReadAdapter({ fetch: vi.fn() })
    expect(adapter.name).toBe('github.read')
    expect(adapter.version).toBe('1.0.0')
    expect(adapter.capabilities()).toEqual({
      actions: ['get_repository'], behavior: 'read', side_effect_level: 0,
      authentication_required: false, idempotency_supported: true,
      verification_supported: true, retry_safe: true,
    })
  })

  it('validates explicit provider input without a network request', async () => {
    const fakeFetch = vi.fn<FetchLike>()
    const adapter = new GitHubReadAdapter({ fetch: fakeFetch })
    await expect(adapter.validate(input, context)).resolves.toBeUndefined()
    expect(fakeFetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ operation: 'delete_repository', owner: 'octocat', repo: 'Hello-World' }, 'operation'],
    [{ operation: 'get_repository', repo: 'Hello-World' }, 'owner'],
    [{ operation: 'get_repository', owner: '../octocat', repo: 'Hello-World' }, 'owner'],
    [{ operation: 'get_repository', owner: 'octocat', repo: '..' }, 'repo'],
    [{ operation: 'get_repository', owner: 'octocat', repo: 'Hello-World', token: 'forbidden' }, 'Unsupported'],
  ])('rejects invalid, ambiguous, or credential-bearing input %#', async (invalid, message) => {
    const adapter = new GitHubReadAdapter({ fetch: vi.fn() })
    await expect(adapter.validate(invalid, context)).rejects.toEqual(expect.objectContaining<Partial<GitHubAdapterValidationError>>({ code: 'VALIDATION_ERROR', message: expect.stringContaining(message) }))
  })

  it('normalizes a successful response, captures request ID, and keeps a minimal untrusted output', async () => {
    const { adapter } = adapterWith(response(repository, 200, { 'x-github-request-id': 'GH-REQUEST-123' }))
    const result = await adapter.execute(input, context)
    expect(result).toMatchObject({
      success: true, provider: 'github.read', provider_version: '1.0.0', operation: 'get_repository',
      provider_request_id: 'GH-REQUEST-123', retryability: 'non_retryable',
      output: { repository_id: 1, full_name: 'octocat/Hello-World', requested_owner: 'octocat', requested_repo: 'Hello-World' },
    })
    expect(result.output).not.toHaveProperty('ignored_provider_payload')
  })

  it.each([
    [401, 'AUTH_ERROR', 'non_retryable'],
    [403, 'PERMISSION_DENIED', 'non_retryable'],
    [404, 'NOT_FOUND', 'non_retryable'],
    [429, 'RATE_LIMITED', 'retryable'],
    [503, 'TRANSIENT_PROVIDER_ERROR', 'retryable'],
  ] as const)('normalizes HTTP %i as %s', async (status, code, retryability) => {
    const { adapter } = adapterWith(response({ message: 'provider detail is ignored' }, status, { 'x-github-request-id': `request-${status}` }))
    await expect(adapter.execute(input, context)).resolves.toMatchObject({
      success: false, provider_request_id: `request-${status}`, retryability, error: { code },
    })
  })

  it('recognizes GitHub secondary rate-limit metadata on HTTP 403', async () => {
    const { adapter } = adapterWith(response({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' }))
    await expect(adapter.execute(input, context)).resolves.toMatchObject({ retryability: 'retryable', error: { code: 'RATE_LIMITED' } })
  })

  it('normalizes timeout and network failures without reflecting raw thrown text', async () => {
    const timeout = adapterWith(new DOMException('secret provider detail', 'AbortError')).adapter
    const network = adapterWith(new Error('token=must-not-leak')).adapter
    const timedOut = await timeout.execute(input, context)
    const failed = await network.execute(input, context)
    expect(timedOut).toMatchObject({ retryability: 'retryable', error: { code: 'TIMEOUT' } })
    expect(failed).toMatchObject({ retryability: 'retryable', error: { code: 'TRANSIENT_PROVIDER_ERROR' } })
    expect(JSON.stringify([timedOut, failed])).not.toContain('must-not-leak')
    expect(JSON.stringify([timedOut, failed])).not.toContain('secret provider detail')
  })

  it('rejects malformed JSON and unexpected provider schemas', async () => {
    const malformed = new GitHubReadAdapter({ fetch: async () => new Response('{broken', { status: 200 }) })
    const unexpected = adapterWith(response({ id: 1, full_name: 'octocat/Hello-World' })).adapter
    await expect(malformed.execute(input, context)).resolves.toMatchObject({ success: false, error: { code: 'UNKNOWN_PROVIDER_ERROR' } })
    await expect(unexpected.execute(input, context)).resolves.toMatchObject({ success: false, error: { code: 'UNKNOWN_PROVIDER_ERROR' } })
  })

  it('uses an optional runtime token only at the request boundary', async () => {
    const secret = 'github-secret-value'
    const { adapter, fakeFetch } = adapterWith(response(repository), secret)
    const result = await adapter.execute(input, context)
    const headers = new Headers(fakeFetch.mock.calls[0][1]?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${secret}`)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('verifies requested identity and explicit expected outcome', async () => {
    const { adapter } = adapterWith(response(repository))
    const result = await adapter.execute(input, context)
    await expect(adapter.verify(result, { full_name: 'octocat/Hello-World', visibility: 'public' }, context)).resolves.toMatchObject({ status: 'PASS' })
    await expect(adapter.verify(result, { default_branch: 'main' }, context)).resolves.toMatchObject({ status: 'FAIL' })
  })

  it('returns FAIL for identity mismatch and UNKNOWN when identity cannot be established', async () => {
    const { adapter } = adapterWith(response(repository))
    const result = await adapter.execute(input, context)
    const mismatch = structuredClone(result)
    mismatch.output = { ...mismatch.output, full_name: 'attacker/other' }
    const incomplete: AdapterExecutionResult = { success: true, provider: 'github.read', operation: 'get_repository', output: {}, retryability: 'non_retryable' }
    await expect(adapter.verify(mismatch, undefined, context)).resolves.toMatchObject({ status: 'FAIL' })
    await expect(adapter.verify(incomplete, undefined, context)).resolves.toMatchObject({ status: 'UNKNOWN' })
    await expect(adapter.verify({ ...incomplete, success: false, retryability: 'unknown' }, undefined, context)).resolves.toMatchObject({ status: 'UNKNOWN' })
  })
})

describe('github.read Runner OS integration', () => {
  it('runs policy → adapter → observe → verify → evidence → audit → delivery and replays duplicates', async () => {
    const secret = 'integration-github-secret'
    const fakeFetch = vi.fn<FetchLike>(async () => response(repository, 200, { 'x-github-request-id': 'GH-INTEGRATION-1' }))
    const store = new InMemoryRunnerStore()
    const runtime = createRunner(deterministicOptions(), {}, store, { fetch: fakeFetch, token: secret })
    const submitted = githubTask()
    const first = await runtime.engine.execute(submitted)
    const replay = await runtime.engine.execute({ ...submitted, task_id: 'duplicate-github-task' })

    expect(first).toMatchObject({ status: 'completed', outputs: [{ output: { full_name: 'octocat/Hello-World' } }] })
    expect(replay).toEqual(first)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
    expect(first.evidence).toHaveLength(2)
    expect(first.evidence[0].payload_reference).toMatchObject({
      normalized_status: 'success', provider: 'github.read', provider_version: '1.0.0',
      operation: 'get_repository', provider_request_id: 'GH-INTEGRATION-1',
    })
    const audit = await store.getAudit(first.run_id)
    expect(audit.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'policy.evaluated', 'step.execution_started', 'step.observed', 'step.verified', 'evidence.persisted', 'run.delivered',
    ]))
    expect(JSON.stringify({ first, audit, steps: await store.getSteps(first.run_id) })).not.toContain(secret)
  })

  it('keeps provider retry classification bounded by Runner OS', async () => {
    const fakeFetch = vi.fn<FetchLike>(async () => response({ message: 'unavailable' }, 503))
    const runtime = createRunner(deterministicOptions({ retryPolicy: { maxAttempts: 2 } }), {}, new InMemoryRunnerStore(), { fetch: fakeFetch })
    const result = await runtime.engine.execute(githubTask('github-retry-key'))
    expect(result).toMatchObject({ status: 'failed', errors: [{ code: 'RETRY_BUDGET_EXHAUSTED', attempt: 2 }] })
    expect(fakeFetch).toHaveBeenCalledTimes(2)
  })

  it('recovers interrupted read-only work once and repeated recovery remains idempotent', async () => {
    const store = new InMemoryRunnerStore()
    const task = githubTask('github-recovery-key') as Task
    const run: Run = { run_id: 'github-recovery-run', task_id: task.task_id, status: 'executing', started_at: '2026-09-10T00:00:00.000Z', attempt: 1 }
    const step: Step = {
      step_id: 'github-recovery-run:step:1', run_id: run.run_id, sequence: 1, tool: 'github.read', action: 'get_repository', input,
      expected_outcome: { full_name: 'octocat/Hello-World' }, risk_level: 0, status: 'executing', attempt: 1,
      idempotency_key: 'github-recovery-run:step:1:operation', verification_status: 'UNKNOWN',
    }
    await store.saveRun(run)
    await store.saveTask(task)
    await store.saveStep(step)
    await store.claimIdempotency(task.idempotency_key, run.run_id, '2026-09-09T23:58:00.000Z', 'abandoned', '2026-09-09T23:59:00.000Z')
    const fakeFetch = vi.fn<FetchLike>(async () => response(repository))
    const runtime = createRunner(deterministicOptions({ createId: (() => { let id = 0; return () => `recovery-${++id}` })() }), {}, store, { fetch: fakeFetch })

    const first = await runtime.engine.recover(run.run_id)
    const repeated = await runtime.engine.recover(run.run_id)
    expect(first.status).toBe('completed')
    expect(repeated).toEqual(first)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })
})
