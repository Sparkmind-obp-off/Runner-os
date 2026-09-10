import type {
  AdapterCapabilities,
  AdapterExecutionResult,
  ExecutionContext,
  RunnerError,
  ToolAdapter,
  VerificationResult,
} from '../core/types'

const OPERATION = 'get_repository'
const API_BASE_URL = 'https://api.github.com'
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/
const ALLOWED_INPUT_KEYS = new Set(['operation', 'owner', 'repo'])

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface GitHubReadAdapterOptions {
  fetch?: FetchLike
  token?: string
  timeoutMs?: number
}

interface RepositoryIdentity {
  operation: typeof OPERATION
  owner: string
  repo: string
}

interface GitHubRepositoryResponse {
  id: number
  name: string
  full_name: string
  owner: { login: string }
  html_url: string
  private: boolean
  archived: boolean
  default_branch: string
}

export class GitHubAdapterValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'

  constructor(message: string) {
    super(message)
    this.name = 'GitHubAdapterValidationError'
  }
}

export class GitHubReadAdapter implements ToolAdapter {
  readonly name = 'github.read'
  readonly version = '1.0.0'
  private readonly fetchImpl: FetchLike
  private readonly token?: string
  private readonly timeoutMs: number

  constructor(options: GitHubReadAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  capabilities(): AdapterCapabilities {
    return {
      actions: [OPERATION],
      behavior: 'read',
      side_effect_level: 0,
      authentication_required: false,
      idempotency_supported: true,
      verification_supported: true,
      retry_safe: true,
    }
  }

  async validate(input: Record<string, unknown>, _context: ExecutionContext): Promise<void> {
    parseInput(input)
  }

  async execute(input: Record<string, unknown>, context: ExecutionContext): Promise<AdapterExecutionResult> {
    let identity: RepositoryIdentity
    try {
      identity = parseInput(input)
    } catch (error) {
      return failure('VALIDATION_ERROR', safeValidationMessage(error), 'non_retryable', context.attempt)
    }

    if (context.is_cancelled()) {
      return failure('CANCELLED', 'Execution was cancelled before the provider request.', 'non_retryable', context.attempt)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(
        `${API_BASE_URL}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}`,
        {
          method: 'GET',
          headers: this.headers(),
          signal: controller.signal,
        },
      )
    } catch (error) {
      const timedOut = controller.signal.aborted || isAbortError(error)
      return failure(
        timedOut ? 'TIMEOUT' : 'TRANSIENT_PROVIDER_ERROR',
        timedOut ? 'GitHub request timed out; no successful result was observed.' : 'GitHub request failed before a response was observed.',
        'retryable',
        context.attempt,
      )
    } finally {
      clearTimeout(timeout)
    }

    const requestId = response.headers.get('x-github-request-id') ?? response.headers.get('x-request-id') ?? undefined
    if (!response.ok) return responseFailure(response.status, response.headers, requestId, context.attempt)

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return failure('UNKNOWN_PROVIDER_ERROR', 'GitHub returned malformed JSON.', 'non_retryable', context.attempt, requestId)
    }
    if (!isRepositoryResponse(payload)) {
      return failure('UNKNOWN_PROVIDER_ERROR', 'GitHub returned an unexpected repository response.', 'non_retryable', context.attempt, requestId)
    }

    return {
      success: true,
      provider: this.name,
      provider_version: this.version,
      operation: identity.operation,
      provider_request_id: requestId,
      output: {
        repository_id: payload.id,
        owner: payload.owner.login,
        name: payload.name,
        full_name: payload.full_name,
        html_url: payload.html_url,
        visibility: payload.private ? 'private' : 'public',
        archived: payload.archived,
        default_branch: payload.default_branch,
        requested_owner: identity.owner,
        requested_repo: identity.repo,
      },
      retryability: 'non_retryable',
    }
  }

  async verify(result: AdapterExecutionResult, expected: Record<string, unknown> | undefined, _context: ExecutionContext): Promise<VerificationResult> {
    if (!result.success) {
      return {
        status: result.retryability === 'unknown' ? 'UNKNOWN' : 'FAIL',
        summary: result.retryability === 'unknown'
          ? 'Repository identity cannot be verified because provider outcome is unknown.'
          : 'Repository identity cannot be verified because execution failed.',
      }
    }

    const output = result.output
    if (!output || !isNonEmptyString(output.owner) || !isNonEmptyString(output.name)
      || !isNonEmptyString(output.full_name) || !isNonEmptyString(output.requested_owner)
      || !isNonEmptyString(output.requested_repo) || typeof output.repository_id !== 'number') {
      return { status: 'UNKNOWN', summary: 'Repository identity cannot be established from the normalized provider output.' }
    }

    const identityMatches = equalIdentifier(output.owner, output.requested_owner)
      && equalIdentifier(output.name, output.requested_repo)
      && equalIdentifier(output.full_name, `${output.requested_owner}/${output.requested_repo}`)
    if (!identityMatches) {
      return {
        status: 'FAIL',
        summary: 'Observed GitHub repository identity does not match the requested owner and repository.',
        details: {
          requested_full_name: `${output.requested_owner}/${output.requested_repo}`,
          observed_full_name: output.full_name,
        },
      }
    }

    if (expected) {
      const allowedExpected = ['repository_id', 'owner', 'name', 'full_name', 'visibility', 'archived', 'default_branch']
      const unsupported = Object.keys(expected).filter((key) => !allowedExpected.includes(key))
      if (unsupported.length) {
        return { status: 'UNKNOWN', summary: `Expected outcome contains unsupported field(s): ${unsupported.join(', ')}.` }
      }
      const mismatch = Object.entries(expected).find(([key, value]) => output[key] !== value)
      if (mismatch) {
        return {
          status: 'FAIL',
          summary: `Observed repository field ${mismatch[0]} does not match the expected outcome.`,
          details: { field: mismatch[0], expected: mismatch[1], observed: output[mismatch[0]] },
        }
      }
    }

    return {
      status: 'PASS',
      summary: 'Observed GitHub repository identity matches the requested resource and expected outcome.',
      details: { repository_id: output.repository_id, full_name: output.full_name },
    }
  }

  private headers(): Headers {
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    })
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`)
    return headers
  }
}

function parseInput(input: Record<string, unknown>): RepositoryIdentity {
  const unexpected = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key))
  if (unexpected.length) throw new GitHubAdapterValidationError(`Unsupported input field(s): ${unexpected.join(', ')}.`)
  if (input.operation !== OPERATION) throw new GitHubAdapterValidationError(`operation must be ${OPERATION}.`)
  if (!isValidOwner(input.owner)) throw new GitHubAdapterValidationError('owner must be an explicit valid GitHub identifier.')
  if (!isValidRepository(input.repo)) throw new GitHubAdapterValidationError('repo must be an explicit valid GitHub identifier.')
  return { operation: OPERATION, owner: input.owner, repo: input.repo }
}

function isValidOwner(value: unknown): value is string {
  return typeof value === 'string' && OWNER_PATTERN.test(value) && !value.includes('--')
}

function isValidRepository(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_PATTERN.test(value) && value !== '.' && value !== '..'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function equalIdentifier(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function isRepositoryResponse(value: unknown): value is GitHubRepositoryResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const repository = value as Record<string, unknown>
  const owner = repository.owner
  return typeof repository.id === 'number'
    && isNonEmptyString(repository.name)
    && isNonEmptyString(repository.full_name)
    && isNonEmptyString(repository.html_url)
    && typeof repository.private === 'boolean'
    && typeof repository.archived === 'boolean'
    && isNonEmptyString(repository.default_branch)
    && Boolean(owner && typeof owner === 'object' && !Array.isArray(owner) && isNonEmptyString((owner as Record<string, unknown>).login))
}

function responseFailure(status: number, headers: Headers, requestId: string | undefined, attempt: number): AdapterExecutionResult {
  if (status === 401) return failure('AUTH_ERROR', 'GitHub authentication failed.', 'non_retryable', attempt, requestId)
  if (status === 403 && headers.get('x-ratelimit-remaining') === '0') return failure('RATE_LIMITED', 'GitHub rate limit was exceeded.', 'retryable', attempt, requestId)
  if (status === 403) return failure('PERMISSION_DENIED', 'GitHub denied access to the requested repository.', 'non_retryable', attempt, requestId)
  if (status === 404) return failure('NOT_FOUND', 'GitHub repository was not found.', 'non_retryable', attempt, requestId)
  if (status === 429) return failure('RATE_LIMITED', 'GitHub rate limit was exceeded.', 'retryable', attempt, requestId)
  if (status >= 500) return failure('TRANSIENT_PROVIDER_ERROR', 'GitHub is temporarily unavailable.', 'retryable', attempt, requestId)
  return failure('UNKNOWN_PROVIDER_ERROR', `GitHub returned unexpected HTTP status ${status}.`, 'non_retryable', attempt, requestId)
}

function failure(
  code: string,
  message: string,
  retryability: RunnerError['retryability'],
  attempt: number,
  providerRequestId?: string,
): AdapterExecutionResult {
  return {
    success: false,
    provider: 'github.read',
    provider_version: '1.0.0',
    operation: OPERATION,
    provider_request_id: providerRequestId,
    error: { code, message, retryability, attempt },
    retryability,
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError'
}

function safeValidationMessage(error: unknown): string {
  return error instanceof GitHubAdapterValidationError ? error.message : 'GitHub adapter input is invalid.'
}
