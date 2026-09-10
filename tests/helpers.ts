import type { RiskLevel } from '../src/core/types'

let taskCounter = 0

export function task(overrides: Record<string, unknown> = {}) {
  taskCounter += 1
  const risk = (overrides.risk_level ?? 0) as RiskLevel
  return {
    task_id: `task-${taskCounter}`,
    type: 'mock.workflow',
    objective: 'Prove a controlled Runner OS execution',
    input: {
      steps: [{
        tool: 'mock.tool',
        action: risk >= 2 ? 'external' : risk === 1 ? 'write' : 'read',
        input: { operation: 'test', value: 'done' },
        expected_outcome: { accepted: true, action_value: 'done' },
        risk_level: risk,
      }],
    },
    constraints: {},
    risk_level: risk,
    requested_at: '2026-09-10T00:00:00.000Z',
    requested_by: 'test-suite',
    policy_context: {},
    idempotency_key: `task-key-${taskCounter}`,
    ...overrides,
  }
}

export function deterministicOptions(extra: Record<string, unknown> = {}) {
  let sequence = 0
  return {
    now: () => '2026-09-10T00:00:00.000Z',
    nowMs: () => sequence++,
    createId: () => `id-${++sequence}`,
    sleep: async () => undefined,
    ...extra,
  }
}
