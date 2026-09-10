import type { AdapterExecutionResult } from '../core/types'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
}

export function shouldRetry(result: AdapterExecutionResult, attempt: number, policy: RetryPolicy, idempotencyProtected: boolean): boolean {
  return result.retryability === 'retryable' && idempotencyProtected && attempt < policy.maxAttempts
}

export function retryDelay(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)), policy.maxDelayMs)
}
