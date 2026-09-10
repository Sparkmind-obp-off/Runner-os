import type { AdapterCapabilities, AdapterExecutionResult, ExecutionContext, ToolAdapter, VerificationResult } from '../core/types'

export interface MockAdapterOptions {
  transientFailures?: number
  alwaysFail?: boolean
  unknownOutcome?: boolean
  verificationFailure?: boolean
  delayMs?: number
}

export class MockToolAdapter implements ToolAdapter {
  readonly name = 'mock.tool'
  readonly version = '1.0.0'
  private readonly executionsByKey = new Map<string, AdapterExecutionResult>()
  private executionCalls = 0

  constructor(private readonly options: MockAdapterOptions = {}) {}

  capabilities(): AdapterCapabilities {
    return {
      actions: ['read', 'write', 'external', 'dangerous'],
      behavior: 'mixed',
      side_effect_level: 3,
      authentication_required: false,
      idempotency_supported: true,
      verification_supported: true,
      retry_safe: true,
    }
  }

  async validate(input: Record<string, unknown>, _context: ExecutionContext): Promise<void> {
    if (input.invalid === true) throw new Error('Mock input is invalid')
  }

  async execute(input: Record<string, unknown>, context: ExecutionContext): Promise<AdapterExecutionResult> {
    const existing = this.executionsByKey.get(context.idempotency_key)
    if (existing) return structuredClone(existing)

    this.executionCalls += 1
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
    if (context.is_cancelled()) {
      return failure('CANCELLED', 'Execution was cancelled.', 'non_retryable', context.attempt)
    }
    if (this.options.unknownOutcome) {
      return failure('TIMEOUT', 'Provider outcome is unknown after timeout.', 'unknown', context.attempt)
    }
    if (this.options.alwaysFail || this.executionCalls <= (this.options.transientFailures ?? 0)) {
      return failure('TRANSIENT_PROVIDER_ERROR', 'Mock transient provider failure.', 'retryable', context.attempt)
    }

    const output = { accepted: true, action_value: input.value ?? null, untrusted_text: input.untrusted_text ?? null }
    const result: AdapterExecutionResult = {
      success: true,
      provider: this.name,
      operation: String(input.operation ?? 'mock-operation'),
      provider_request_id: `mock-request-${this.executionCalls}`,
      output,
      retryability: 'non_retryable',
      side_effect_reference: `mock-record-${this.executionCalls}`,
    }
    this.executionsByKey.set(context.idempotency_key, structuredClone(result))
    return result
  }

  async verify(result: AdapterExecutionResult, expected: Record<string, unknown> | undefined, _context: ExecutionContext): Promise<VerificationResult> {
    if (this.options.verificationFailure) return { status: 'FAIL', summary: 'Mock verification was configured to fail.' }
    if (!result.success) return { status: result.retryability === 'unknown' ? 'UNKNOWN' : 'FAIL', summary: result.error?.message ?? 'Execution failed.' }
    if (!expected) return { status: 'PASS', summary: 'Execution result exists and is independently observable.' }
    const matches = Object.entries(expected).every(([key, value]) => result.output?.[key] === value)
    return matches
      ? { status: 'PASS', summary: 'Observed output matches the expected outcome.', details: expected }
      : { status: 'FAIL', summary: 'Observed output does not match the expected outcome.', details: { expected, observed: result.output ?? {} } }
  }

  getExecutionCount(): number { return this.executionCalls }
}

function failure(code: string, message: string, retryability: 'retryable' | 'non_retryable' | 'unknown', attempt: number): AdapterExecutionResult {
  return {
    success: false,
    provider: 'mock.tool',
    operation: 'mock-operation',
    error: { code, message, retryability, attempt },
    retryability,
  }
}
