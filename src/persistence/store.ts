import type { AuditEvent, DeliveryResult, Evidence, Run, Step, Task } from '../core/types'

export interface RunnerStore {
  saveTask(task: Task): void
  saveRun(run: Run): void
  saveStep(step: Step): void
  appendEvidence(evidence: Evidence): void
  appendAudit(event: AuditEvent): void
  getRun(runId: string): Run | undefined
  getSteps(runId: string): Step[]
  getEvidence(runId: string): Evidence[]
  getAudit(runId: string): AuditEvent[]
  getIdempotentResult(key: string): DeliveryResult | undefined
  saveIdempotentResult(key: string, result: DeliveryResult): void
}

const copy = <T>(value: T): T => structuredClone(value)

export class InMemoryRunnerStore implements RunnerStore {
  private readonly tasks = new Map<string, Task>()
  private readonly runs = new Map<string, Run>()
  private readonly steps = new Map<string, Step>()
  private readonly evidence: Evidence[] = []
  private readonly audit: AuditEvent[] = []
  private readonly idempotency = new Map<string, DeliveryResult>()

  saveTask(task: Task): void { this.tasks.set(task.task_id, copy(task)) }
  saveRun(run: Run): void { this.runs.set(run.run_id, copy(run)) }
  saveStep(step: Step): void { this.steps.set(step.step_id, copy(step)) }
  appendEvidence(evidence: Evidence): void { this.evidence.push(copy(evidence)) }
  appendAudit(event: AuditEvent): void { this.audit.push(copy(event)) }
  getRun(runId: string): Run | undefined { const value = this.runs.get(runId); return value ? copy(value) : undefined }
  getSteps(runId: string): Step[] { return [...this.steps.values()].filter((step) => step.run_id === runId).sort((a, b) => a.sequence - b.sequence).map(copy) }
  getEvidence(runId: string): Evidence[] { return this.evidence.filter((item) => item.run_id === runId).map(copy) }
  getAudit(runId: string): AuditEvent[] { return this.audit.filter((event) => event.run_id === runId).map(copy) }
  getIdempotentResult(key: string): DeliveryResult | undefined { const value = this.idempotency.get(key); return value ? copy(value) : undefined }
  saveIdempotentResult(key: string, result: DeliveryResult): void { this.idempotency.set(key, copy(result)) }
}
