import type { RunStatus, StepStatus } from './types'

const runTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ['validating', 'cancelled'],
  validating: ['planning', 'failed', 'cancelled'],
  planning: ['awaiting_approval', 'executing', 'blocked', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'blocked', 'cancelled', 'expired'],
  executing: ['verifying', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [], blocked: [], expired: [],
}

const stepTransitions: Record<StepStatus, StepStatus[]> = {
  pending: ['validating', 'blocked', 'skipped'],
  validating: ['executing', 'blocked', 'failed'],
  executing: ['verifying', 'retryable_failure', 'failed', 'skipped'],
  retryable_failure: ['executing', 'failed'],
  verifying: ['succeeded', 'failed'],
  succeeded: [], failed: [], blocked: [], skipped: [],
}

export function transitionRun(current: RunStatus, next: RunStatus): RunStatus {
  if (!runTransitions[current].includes(next)) {
    throw new Error(`Invalid run transition: ${current} -> ${next}`)
  }
  return next
}

export function transitionStep(current: StepStatus, next: StepStatus): StepStatus {
  if (!stepTransitions[current].includes(next)) {
    throw new Error(`Invalid step transition: ${current} -> ${next}`)
  }
  return next
}

export const terminalRunStatuses: ReadonlySet<RunStatus> = new Set([
  'completed', 'failed', 'cancelled', 'blocked', 'expired',
])
