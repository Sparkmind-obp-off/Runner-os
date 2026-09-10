import { describe, expect, it } from 'vitest'
import { normalizeTask, validateTask, ContractValidationError } from '../src/core/contracts'
import { transitionRun, transitionStep } from '../src/core/state-machine'
import { redact } from '../src/security/redaction'
import { task } from './helpers'

describe('Phase 0 contracts', () => {
  it('normalizes aliases and defaults without inventing executable content', () => {
    const normalized = normalizeTask({
      task_type: ' mock.workflow ', objective: ' run ', requested_by: ' user ',
      input: { steps: [{ tool: ' mock.tool ', action: ' read ', input: {}, risk_level: 0 }] },
      idempotency_key: ' key ',
    }, '2026-09-10T00:00:00.000Z', () => 'generated-task')

    expect(normalized).toMatchObject({ task_id: 'generated-task', type: 'mock.workflow', objective: 'run', requested_by: 'user', idempotency_key: 'key' })
    expect(() => validateTask(normalized)).not.toThrow()
  })

  it('rejects an invalid task contract', () => {
    const normalized = normalizeTask({}, '2026-09-10T00:00:00.000Z', () => 'generated-task')
    expect(() => validateTask(normalized)).toThrow(ContractValidationError)
  })
})

describe('state machine invariants', () => {
  it('allows only declared run and step transitions', () => {
    expect(transitionRun('queued', 'validating')).toBe('validating')
    expect(transitionStep('executing', 'verifying')).toBe('verifying')
    expect(() => transitionRun('completed', 'executing')).toThrow('Invalid run transition')
    expect(() => transitionStep('succeeded', 'executing')).toThrow('Invalid step transition')
  })
})

describe('security redaction', () => {
  it('redacts nested credentials while preserving useful fields', () => {
    expect(redact({ token: 'secret-value', nested: { api_key: 'key-value', value: 'safe' } })).toEqual({
      token: '[REDACTED]', nested: { api_key: '[REDACTED]', value: 'safe' },
    })
  })

  it('does not mutate task fixtures', () => {
    const input = task()
    const output = redact(input)
    expect(output).toEqual(input)
    expect(output).not.toBe(input)
  })
})
