import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/engine/factory'
import { InMemoryRunnerStore } from '../src/persistence/store'
import type { Evidence, Run, Step, Task } from '../src/core/types'
import { deterministicOptions, task as taskFixture } from './helpers'

const NOW = '2026-09-10T00:00:00.000Z'
const EXPIRED = '2026-09-09T23:59:00.000Z'

function phase3Options(extra: Record<string, unknown> = {}) {
  return deterministicOptions({ leaseMs: 60_000, ...extra })
}

function freshOptions(prefix: string) {
  let sequence = 0
  return phase3Options({ createId: () => `${prefix}-${++sequence}` })
}

async function seedInterrupted(store: InMemoryRunnerStore, riskLevel: 0 | 1 = 1, withSuccessfulEvidence = false) {
  const task = taskFixture({ task_id: `interrupted-task-${riskLevel}`, idempotency_key: `interrupted-key-${riskLevel}`, risk_level: riskLevel }) as Task
  const run: Run = { run_id: `interrupted-run-${riskLevel}`, task_id: task.task_id, status: 'executing', started_at: NOW, attempt: 1 }
  const step: Step = {
    step_id: `${run.run_id}:step:1`, run_id: run.run_id, sequence: 1, tool: 'mock.tool', action: riskLevel ? 'write' : 'read',
    input: { value: 'done' }, expected_outcome: { accepted: true, action_value: 'done' }, risk_level: riskLevel,
    status: 'executing', attempt: 1, idempotency_key: `${run.run_id}:step:1:operation`, verification_status: 'UNKNOWN',
  }
  await store.saveRun(run)
  await store.saveTask(task)
  await store.saveStep(step)
  await store.claimIdempotency(task.idempotency_key, run.run_id, EXPIRED, 'abandoned-owner', EXPIRED)
  if (withSuccessfulEvidence) {
    const evidence: Evidence = {
      evidence_id: `execution-${riskLevel}`, run_id: run.run_id, step_id: step.step_id, type: 'execution', source: 'mock.tool', captured_at: EXPIRED,
      integrity_hash: 'fnv1a:test', payload_reference: { success: true, provider: 'mock.tool', operation: step.action, output: { accepted: true, action_value: 'done' }, side_effect_reference: 'provider-record-1' },
    }
    await store.appendEvidence(evidence)
  }
  return { task, run, step }
}

describe('Phase 3 durable approvals', () => {
  it('persists pending approval and resumes safely from a fresh runtime', async () => {
    const store = new InMemoryRunnerStore()
    const first = createRunner(phase3Options(), {}, store)
    const pending = await first.engine.execute(taskFixture({ risk_level: 2, idempotency_key: 'approval-resume-key' }))
    expect(pending.status).toBe('awaiting_approval')
    const approval = await store.getApproval(pending.run_id)
    expect(approval).toMatchObject({ status: 'pending', risk_level: 2 })

    const fresh = createRunner(freshOptions('approval-resume'), {}, store)
    const completed = await fresh.engine.decideApproval(pending.run_id, 'approved', 'approver-42', 'Reviewed safely')
    expect(completed.status).toBe('completed')
    expect(fresh.mock.getExecutionCount()).toBe(1)
    expect((await store.getAudit(pending.run_id)).map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'approval.requested', 'approval.approved', 'idempotency.claim_recovered', 'run.recovery_completed',
    ]))
  })

  it('makes duplicate decisions idempotent and never executes a rejected action', async () => {
    const store = new InMemoryRunnerStore()
    const runtime = createRunner(phase3Options(), {}, store)
    const pending = await runtime.engine.execute(taskFixture({ risk_level: 3, idempotency_key: 'approval-reject-key' }))
    const rejected = await runtime.engine.decideApproval(pending.run_id, 'rejected', 'approver-42', 'Too risky')
    const duplicate = await runtime.engine.decideApproval(pending.run_id, 'rejected', 'approver-42', 'Too risky')
    expect(rejected.status).toBe('blocked')
    expect(duplicate).toEqual(rejected)
    expect(runtime.mock.getExecutionCount()).toBe(0)
    expect((await store.getAudit(pending.run_id)).filter((event) => event.event_type === 'approval.rejected')).toHaveLength(1)
  })

  it('never executes an expired approval', async () => {
    const input = taskFixture({
      risk_level: 2,
      policy_context: { approvals: [{ approval_id: 'expired-approval', requested_action: 'external', risk_level: 2, approver: 'approver-42', decision: 'APPROVED', timestamp: EXPIRED, expires_at: EXPIRED }] },
    })
    const { engine, mock, store } = createRunner(phase3Options())
    const result = await engine.execute(input)
    expect(result.status).toBe('expired')
    expect(mock.getExecutionCount()).toBe(0)
    expect((await store.getAudit(result.run_id)).some((event) => event.event_type === 'approval.expired')).toBe(true)
  })
})

describe('Phase 3 idempotency leases', () => {
  it('protects a live lease, recovers an expired lease atomically, and replays completion', async () => {
    const store = new InMemoryRunnerStore()
    await store.saveRun({ run_id: 'lease-run', task_id: 'unresolved', status: 'queued', started_at: NOW, attempt: 1 })
    const first = await store.claimIdempotency('lease-key', 'lease-run', NOW, 'owner-1', '2026-09-10T00:01:00.000Z')
    expect(first.claimed).toBe(true)
    expect((await store.recoverIdempotencyClaim('lease-key', 'lease-run', 'owner-1', 'owner-2', '2026-09-10T00:00:30.000Z', '2026-09-10T00:02:00.000Z')).claimed).toBe(false)
    const recovered = await store.recoverIdempotencyClaim('lease-key', 'lease-run', 'owner-1', 'owner-2', '2026-09-10T00:01:00.000Z', '2026-09-10T00:02:00.000Z')
    expect(recovered).toMatchObject({ claimed: true, recovered: true, owner_token: 'owner-2' })
    const result = { status: 'completed' as const, run_id: 'lease-run', summary: 'done', outputs: [], evidence: [], warnings: [], errors: [], next_action: null }
    await store.saveIdempotentResult('lease-key', result, 'owner-2')
    expect(await store.getIdempotentResult('lease-key')).toEqual(result)
    expect((await store.claimIdempotency('lease-key', 'other-run', NOW)).result).toEqual(result)
  })
})

describe('Phase 3 restart recovery and cancellation', () => {
  it('verifies an interrupted mutation as successful without executing it again', async () => {
    const store = new InMemoryRunnerStore()
    const { run } = await seedInterrupted(store, 1, true)
    const fresh = createRunner(phase3Options(), {}, store)
    const result = await fresh.engine.recover(run.run_id)
    expect(result.status).toBe('completed')
    expect(fresh.mock.getExecutionCount()).toBe(0)
    expect((await store.getSteps(run.run_id))[0]).toMatchObject({ status: 'succeeded', recovery_outcome: 'KNOWN_SUCCESS' })
  })

  it('blocks an ambiguous interrupted mutation and repeated recovery cannot replay it', async () => {
    const store = new InMemoryRunnerStore()
    const { run } = await seedInterrupted(store, 1, false)
    const fresh = createRunner(phase3Options(), {}, store)
    const first = await fresh.engine.recover(run.run_id)
    const second = await fresh.engine.recover(run.run_id)
    expect(first).toMatchObject({ status: 'blocked', errors: [{ code: 'RECOVERY_BLOCKED' }] })
    expect(second.status).toBe('blocked')
    expect(fresh.mock.getExecutionCount()).toBe(0)
    expect((await store.getAudit(run.run_id)).some((event) => event.event_type === 'run.recovery_blocked')).toBe(true)
  })

  it('retries only after verification proves an interrupted side effect did not happen', async () => {
    const store = new InMemoryRunnerStore()
    const { run } = await seedInterrupted(store, 1, false)
    const fresh = createRunner(phase3Options(), { unknownVerificationStatus: 'FAIL' }, store)
    const result = await fresh.engine.recover(run.run_id)
    expect(result.status).toBe('completed')
    expect(fresh.mock.getExecutionCount()).toBe(1)
    expect((await store.getAudit(run.run_id)).some((event) => event.event_type === 'recovery.retry_allowed')).toBe(true)
  })

  it('safely resumes interrupted non-side-effecting work', async () => {
    const store = new InMemoryRunnerStore()
    const { run } = await seedInterrupted(store, 0, false)
    const fresh = createRunner(phase3Options(), {}, store)
    const result = await fresh.engine.recover(run.run_id)
    expect(result.status).toBe('completed')
    expect(fresh.mock.getExecutionCount()).toBe(1)
  })

  it('persists cancellation across runtime restart and prevents a pending side effect', async () => {
    const store = new InMemoryRunnerStore()
    const first = createRunner(phase3Options(), {}, store)
    const pending = await first.engine.execute(taskFixture({ risk_level: 2, idempotency_key: 'cancel-durable-key' }))
    expect(await first.engine.cancel(pending.run_id, 'operator-7')).toBe(true)
    expect(await first.engine.cancel(pending.run_id, 'operator-7')).toBe(true)
    const fresh = createRunner(freshOptions('cancel-restart'), {}, store)
    const result = await fresh.engine.recover(pending.run_id)
    expect(result.status).toBe('cancelled')
    expect(fresh.mock.getExecutionCount()).toBe(0)
    expect((await store.getAudit(pending.run_id)).filter((event) => event.event_type === 'run.cancellation_requested')).toHaveLength(1)
  })

  it('never resurrects a terminal run', async () => {
    const store = new InMemoryRunnerStore()
    const runtime = createRunner(phase3Options(), {}, store)
    const completed = await runtime.engine.execute(taskFixture({ idempotency_key: 'terminal-key' }))
    const replay = await runtime.engine.recover(completed.run_id)
    expect(replay).toEqual(completed)
    expect(runtime.mock.getExecutionCount()).toBe(1)
  })
})
