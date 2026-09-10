import { terminalRunStatuses } from '../core/state-machine'
import type { AuditEvent, DeliveryResult, Evidence, Run, Step, Task } from '../core/types'

export type Awaitable<T> = T | Promise<T>

export interface IdempotencyClaim {
  claimed: boolean
  result?: DeliveryResult
}

export interface RunnerStore {
  saveTask(task: Task): Awaitable<void>
  saveRun(run: Run): Awaitable<void>
  saveStep(step: Step): Awaitable<void>
  appendEvidence(evidence: Evidence): Awaitable<void>
  appendAudit(event: AuditEvent): Awaitable<void>
  getRun(runId: string): Awaitable<Run | undefined>
  getSteps(runId: string): Awaitable<Step[]>
  getEvidence(runId: string): Awaitable<Evidence[]>
  getAudit(runId: string): Awaitable<AuditEvent[]>
  claimIdempotency(key: string, runId: string, claimedAt: string): Awaitable<IdempotencyClaim>
  getIdempotentResult(key: string): Awaitable<DeliveryResult | undefined>
  saveIdempotentResult(key: string, result: DeliveryResult): Awaitable<void>
}

const copy = <T>(value: T): T => structuredClone(value)

export class InMemoryRunnerStore implements RunnerStore {
  private readonly tasks = new Map<string, Task>()
  private readonly runs = new Map<string, Run>()
  private readonly steps = new Map<string, Step>()
  private readonly evidence: Evidence[] = []
  private readonly audit: AuditEvent[] = []
  private readonly idempotency = new Map<string, { runId: string; result?: DeliveryResult }>()

  saveTask(task: Task): void { this.tasks.set(task.task_id, copy(task)) }
  saveRun(run: Run): void {
    const current = this.runs.get(run.run_id)
    if (current && terminalRunStatuses.has(current.status) && current.status !== run.status) {
      throw new Error(`Cannot replace terminal run ${run.run_id} status ${current.status} with ${run.status}.`)
    }
    this.runs.set(run.run_id, copy(run))
  }
  saveStep(step: Step): void {
    const current = this.steps.get(step.step_id)
    const terminal = ['succeeded', 'failed', 'blocked', 'skipped']
    if (current && terminal.includes(current.status) && current.status !== step.status) {
      throw new Error(`Cannot replace terminal step ${step.step_id} status ${current.status} with ${step.status}.`)
    }
    this.steps.set(step.step_id, copy(step))
  }
  appendEvidence(evidence: Evidence): void {
    if (this.evidence.some((item) => item.evidence_id === evidence.evidence_id)) throw new Error(`Evidence already exists: ${evidence.evidence_id}`)
    this.evidence.push(copy(evidence))
  }
  appendAudit(event: AuditEvent): void {
    if (this.audit.some((item) => item.event_id === event.event_id)) throw new Error(`Audit event already exists: ${event.event_id}`)
    this.audit.push(copy(event))
  }
  getRun(runId: string): Run | undefined { const value = this.runs.get(runId); return value ? copy(value) : undefined }
  getSteps(runId: string): Step[] { return [...this.steps.values()].filter((step) => step.run_id === runId).sort((a, b) => a.sequence - b.sequence).map(copy) }
  getEvidence(runId: string): Evidence[] { return this.evidence.filter((item) => item.run_id === runId).map(copy) }
  getAudit(runId: string): AuditEvent[] { return this.audit.filter((event) => event.run_id === runId).map(copy) }
  claimIdempotency(key: string, runId: string): IdempotencyClaim {
    const existing = this.idempotency.get(key)
    if (existing) return { claimed: false, result: existing.result ? copy(existing.result) : undefined }
    this.idempotency.set(key, { runId })
    return { claimed: true }
  }
  getIdempotentResult(key: string): DeliveryResult | undefined { const value = this.idempotency.get(key)?.result; return value ? copy(value) : undefined }
  saveIdempotentResult(key: string, result: DeliveryResult): void {
    const existing = this.idempotency.get(key)
    this.idempotency.set(key, { runId: existing?.runId ?? result.run_id, result: copy(result) })
  }
}
