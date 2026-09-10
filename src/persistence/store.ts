import { terminalRunStatuses } from '../core/state-machine'
import { redactFreeText } from '../security/redaction'
import type { ApprovalRecord, AuditEvent, DeliveryResult, Evidence, RecoveryOutcome, Run, Step, Task } from '../core/types'

export type Awaitable<T> = T | Promise<T>

export interface IdempotencyClaim {
  claimed: boolean
  owner_run_id: string
  owner_token?: string
  state: 'claimed' | 'completed'
  recovered?: boolean
  lease_expires_at?: string
  result?: DeliveryResult
}

export interface RecoveryAttempt {
  recovery_id: string
  run_id: string
  started_at: string
  completed_at?: string
  classification: 'SAFE_RESUME' | 'AWAITING_APPROVAL' | 'VERIFY_REQUIRED' | 'TERMINAL_IGNORED' | 'RECOVERY_BLOCKED'
  outcome?: RecoveryOutcome
  actor: string
}

export interface RunnerStore {
  saveTask(task: Task): Awaitable<void>
  getTask(taskId: string): Awaitable<Task | undefined>
  saveRun(run: Run): Awaitable<void>
  saveStep(step: Step): Awaitable<void>
  appendEvidence(evidence: Evidence): Awaitable<void>
  appendAudit(event: AuditEvent): Awaitable<void>
  getRun(runId: string): Awaitable<Run | undefined>
  getSteps(runId: string): Awaitable<Step[]>
  getEvidence(runId: string): Awaitable<Evidence[]>
  getAudit(runId: string): Awaitable<AuditEvent[]>
  claimIdempotency(key: string, runId: string, claimedAt: string, ownerToken?: string, leaseExpiresAt?: string): Awaitable<IdempotencyClaim>
  renewIdempotencyLease(key: string, runId: string, ownerToken: string, heartbeatAt: string, leaseExpiresAt: string): Awaitable<boolean>
  recoverIdempotencyClaim(key: string, runId: string, previousOwnerToken: string, ownerToken: string, recoveredAt: string, leaseExpiresAt: string): Awaitable<IdempotencyClaim>
  getIdempotentResult(key: string): Awaitable<DeliveryResult | undefined>
  saveIdempotentResult(key: string, result: DeliveryResult, ownerToken?: string): Awaitable<void>
  createApproval(approval: ApprovalRecord): Awaitable<ApprovalRecord>
  getApproval(runId: string, stepId?: string): Awaitable<ApprovalRecord | undefined>
  decideApproval(approvalId: string, status: 'approved' | 'rejected', actor: string, decidedAt: string, reason?: string): Awaitable<ApprovalRecord | undefined>
  requestCancellation(runId: string, actor: string, requestedAt: string): Awaitable<boolean>
  isCancellationRequested(runId: string): Awaitable<boolean>
  listRecoverableRuns(): Awaitable<Run[]>
  appendRecoveryAttempt(attempt: RecoveryAttempt): Awaitable<void>
  completeRecoveryAttempt(recoveryId: string, completedAt: string, outcome: RecoveryOutcome): Awaitable<void>
}

const copy = <T>(value: T): T => structuredClone(value)

export class InMemoryRunnerStore implements RunnerStore {
  private readonly tasks = new Map<string, Task>()
  private readonly runs = new Map<string, Run>()
  private readonly steps = new Map<string, Step>()
  private readonly evidence: Evidence[] = []
  private readonly audit: AuditEvent[] = []
  private readonly idempotency = new Map<string, { runId: string; ownerToken: string; state: 'claimed' | 'completed'; leaseExpiresAt: string; heartbeatAt: string; result?: DeliveryResult }>()
  private readonly approvals = new Map<string, ApprovalRecord>()
  private readonly recoveries = new Map<string, RecoveryAttempt>()

  saveTask(task: Task): void { this.tasks.set(task.task_id, copy(task)) }
  getTask(taskId: string): Task | undefined { const value = this.tasks.get(taskId); return value ? copy(value) : undefined }
  saveRun(run: Run): void {
    const current = this.runs.get(run.run_id)
    if (current && terminalRunStatuses.has(current.status) && current.status !== run.status) throw new Error(`Cannot replace terminal run ${run.run_id} status ${current.status} with ${run.status}.`)
    this.runs.set(run.run_id, copy(run))
  }
  saveStep(step: Step): void {
    const current = this.steps.get(step.step_id)
    const terminal = ['succeeded', 'failed', 'blocked', 'skipped']
    if (current && terminal.includes(current.status) && current.status !== step.status) throw new Error(`Cannot replace terminal step ${step.step_id} status ${current.status} with ${step.status}.`)
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

  claimIdempotency(key: string, runId: string, claimedAt: string, ownerToken = runId, leaseExpiresAt = claimedAt): IdempotencyClaim {
    const existing = this.idempotency.get(key)
    if (existing) return { claimed: false, owner_run_id: existing.runId, owner_token: existing.ownerToken, state: existing.state, lease_expires_at: existing.leaseExpiresAt, result: existing.result ? copy(existing.result) : undefined }
    this.idempotency.set(key, { runId, ownerToken, state: 'claimed', leaseExpiresAt, heartbeatAt: claimedAt })
    return { claimed: true, owner_run_id: runId, owner_token: ownerToken, state: 'claimed', lease_expires_at: leaseExpiresAt }
  }
  renewIdempotencyLease(key: string, runId: string, ownerToken: string, heartbeatAt: string, leaseExpiresAt: string): boolean {
    const claim = this.idempotency.get(key)
    if (!claim || claim.state !== 'claimed' || claim.runId !== runId || claim.ownerToken !== ownerToken) return false
    claim.heartbeatAt = heartbeatAt; claim.leaseExpiresAt = leaseExpiresAt
    return true
  }
  recoverIdempotencyClaim(key: string, runId: string, previousOwnerToken: string, ownerToken: string, recoveredAt: string, leaseExpiresAt: string): IdempotencyClaim {
    const claim = this.idempotency.get(key)
    if (!claim) return { claimed: false, owner_run_id: runId, state: 'claimed' }
    if (claim.state === 'completed' || claim.runId !== runId || claim.ownerToken !== previousOwnerToken || claim.leaseExpiresAt > recoveredAt) {
      return { claimed: false, owner_run_id: claim.runId, owner_token: claim.ownerToken, state: claim.state, lease_expires_at: claim.leaseExpiresAt, result: claim.result ? copy(claim.result) : undefined }
    }
    claim.ownerToken = ownerToken; claim.heartbeatAt = recoveredAt; claim.leaseExpiresAt = leaseExpiresAt
    return { claimed: true, recovered: true, owner_run_id: runId, owner_token: ownerToken, state: 'claimed', lease_expires_at: leaseExpiresAt }
  }
  getIdempotentResult(key: string): DeliveryResult | undefined { const value = this.idempotency.get(key)?.result; return value ? copy(value) : undefined }
  saveIdempotentResult(key: string, result: DeliveryResult, ownerToken?: string): void {
    const claim = this.idempotency.get(key)
    if (!claim || claim.runId !== result.run_id || (ownerToken && claim.ownerToken !== ownerToken)) throw new Error(`Idempotency claim is not owned by run ${result.run_id}.`)
    claim.state = 'completed'; claim.result = copy(result)
  }

  createApproval(approval: ApprovalRecord): ApprovalRecord {
    const existing = [...this.approvals.values()].find((item) => item.run_id === approval.run_id && item.step_id === approval.step_id)
    if (existing) return copy(existing)
    const safe = { ...approval, approver: redactFreeText(approval.approver), reason: redactFreeText(approval.reason) }
    this.approvals.set(approval.approval_id, copy(safe)); return copy(safe)
  }
  getApproval(runId: string, stepId?: string): ApprovalRecord | undefined {
    const value = [...this.approvals.values()].find((item) => item.run_id === runId && (!stepId || item.step_id === stepId))
    return value ? copy(value) : undefined
  }
  decideApproval(approvalId: string, status: 'approved' | 'rejected', actor: string, decidedAt: string, reason?: string): ApprovalRecord | undefined {
    const approval = this.approvals.get(approvalId)
    if (!approval) return undefined
    if (approval.status === status) return copy(approval)
    if (approval.status !== 'pending') throw new Error(`Approval ${approvalId} already has decision ${approval.status}.`)
    approval.status = status; approval.approver = redactFreeText(actor); approval.decided_at = decidedAt; approval.reason = redactFreeText(reason)
    return copy(approval)
  }
  requestCancellation(runId: string, actor: string, requestedAt: string): boolean {
    const run = this.runs.get(runId)
    if (!run || terminalRunStatuses.has(run.status)) return false
    if (run.cancellation_requested_at) return true
    run.cancellation_requested_at = requestedAt; run.cancellation_requested_by = redactFreeText(actor)
    return true
  }
  isCancellationRequested(runId: string): boolean { return Boolean(this.runs.get(runId)?.cancellation_requested_at) }
  listRecoverableRuns(): Run[] { return [...this.runs.values()].filter((run) => !terminalRunStatuses.has(run.status)).map(copy) }
  appendRecoveryAttempt(attempt: RecoveryAttempt): void {
    if (this.recoveries.has(attempt.recovery_id)) throw new Error(`Recovery attempt already exists: ${attempt.recovery_id}`)
    this.recoveries.set(attempt.recovery_id, copy(attempt))
  }
  completeRecoveryAttempt(recoveryId: string, completedAt: string, outcome: RecoveryOutcome): void {
    const attempt = this.recoveries.get(recoveryId); if (!attempt) throw new Error(`Recovery attempt not found: ${recoveryId}`)
    attempt.completed_at = completedAt; attempt.outcome = outcome
  }
}
