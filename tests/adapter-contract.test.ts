import { describe, expect, it } from 'vitest'
import { MockToolAdapter } from '../src/adapters/mock-adapter'

const context = {
  run_id: 'run-1', step_id: 'step-1', idempotency_key: 'stable-key', attempt: 1, is_cancelled: () => false,
}

describe('ToolAdapter contract: mock.tool', () => {
  it('declares capabilities and validates without side effects', async () => {
    const adapter = new MockToolAdapter()
    expect(adapter.capabilities()).toMatchObject({ idempotency_supported: true, verification_supported: true, retry_safe: true })
    await expect(adapter.validate({ value: 'ok' }, context)).resolves.toBeUndefined()
    expect(adapter.getExecutionCount()).toBe(0)
  })

  it('normalizes execution, verification, and native idempotency', async () => {
    const adapter = new MockToolAdapter()
    const first = await adapter.execute({ value: 'done' }, context)
    const duplicate = await adapter.execute({ value: 'different' }, { ...context, attempt: 2 })
    expect(first).toEqual(duplicate)
    expect(adapter.getExecutionCount()).toBe(1)
    await expect(adapter.verify(first, { accepted: true, action_value: 'done' }, context)).resolves.toMatchObject({ status: 'PASS' })
  })

  it('returns normalized retry and unknown-outcome classifications', async () => {
    const transient = await new MockToolAdapter({ alwaysFail: true }).execute({}, context)
    const unknown = await new MockToolAdapter({ unknownOutcome: true }).execute({}, context)
    expect(transient).toMatchObject({ success: false, retryability: 'retryable', error: { code: 'TRANSIENT_PROVIDER_ERROR' } })
    expect(unknown).toMatchObject({ success: false, retryability: 'unknown', error: { code: 'TIMEOUT' } })
  })
})
