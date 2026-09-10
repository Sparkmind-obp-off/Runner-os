import { AdapterRegistry } from '../adapters/registry'
import { ContractValidationError, normalizeTask, validateTask } from '../core/contracts'
import { integrityHash } from '../core/hash'
import { createDeliveryResult } from '../core/result'
import { terminalRunStatuses, transitionRun, transitionStep } from '../core/state-machine'
import type { AdapterExecutionResult, ApprovalRecord, DeliveryResult, Evidence, RecoveryOutcome, Run, RunnerError, Step, Task, VerificationResult } from '../core/types'
import { AuditRecorder } from '../observability/audit'
import type { RecoveryAttempt, RunnerStore } from '../persistence/store'
import { DefaultPolicyEvaluator, type PolicyEvaluator } from '../policy/evaluator'
import { redact } from '../security/redaction'
import { DeterministicPlanner, type Planner } from './planner'
import { defaultRetryPolicy, retryDelay, shouldRetry, type RetryPolicy } from './retry'

export interface RunnerEngineOptions {
  now?: () => string
  nowMs?: () => number
  createId?: () => string
  planner?: Planner
  policy?: PolicyEvaluator
  retryPolicy?: Partial<RetryPolicy>
  leaseMs?: number
  sleep?: (milliseconds: number) => Promise<void>
  onRunCreated?: (runId: string, engine: RunnerEngine) => void | Promise<void>
}

export class RunnerEngine {
  private readonly now: () => string
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly planner: Planner
  private readonly policy: PolicyEvaluator
  private readonly retryPolicy: RetryPolicy
  private readonly leaseMs: number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly audit: AuditRecorder
  private readonly cancelledRuns = new Set<string>()

  constructor(private readonly store: RunnerStore, private readonly adapters: AdapterRegistry, private readonly options: RunnerEngineOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.planner = options.planner ?? new DeterministicPlanner()
    this.policy = options.policy ?? new DefaultPolicyEvaluator(this.now)
    this.retryPolicy = { ...defaultRetryPolicy, ...options.retryPolicy }
    this.leaseMs = options.leaseMs ?? 60_000
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.audit = new AuditRecorder(store, this.now, this.createId)
  }

  async cancel(runId: string, actor = 'system'): Promise<boolean> {
    const run = await this.store.getRun(runId)
    if (!run || terminalRunStatuses.has(run.status)) return false
    const alreadyRequested = await this.store.isCancellationRequested(runId)
    const accepted = await this.store.requestCancellation(runId, actor, this.now())
    if (!accepted) return false
    this.cancelledRuns.add(runId)
    if (!alreadyRequested) await this.audit.record(runId, 'run.cancellation_requested', actor)
    return true
  }

  async decideApproval(runId: string, decision: 'approved' | 'rejected', actor: string, reason?: string): Promise<DeliveryResult> {
    const run = await this.requiredRun(runId)
    if (terminalRunStatuses.has(run.status)) return this.resultFor(run)
    const approval = await this.store.getApproval(runId)
    if (!approval) throw new Error(`Approval not found for run ${runId}.`)
    const before = approval.status
    const decided = await this.store.decideApproval(approval.approval_id, decision, actor, this.now(), reason)
    if (!decided) throw new Error(`Approval not found: ${approval.approval_id}`)
    if (before === 'pending') await this.audit.record(runId, `approval.${decision}`, actor, { approval_id: approval.approval_id, step_id: approval.step_id, reason })
    if (decision === 'rejected') {
      if (run.status === 'awaiting_approval') await this.setRunStatus(run, 'blocked')
      return this.finish(run, await this.store.getSteps(runId), [{ code: 'APPROVAL_REJECTED', message: reason ?? 'Approval was rejected.', retryability: 'non_retryable', step_id: approval.step_id }], (await this.store.getTask(run.task_id))?.idempotency_key ?? '')
    }
    return this.recover(runId, actor)
  }

  async recover(runId: string, actor = 'recovery'): Promise<DeliveryResult> {
    const run = await this.requiredRun(runId)
    if (terminalRunStatuses.has(run.status)) {
      await this.audit.record(runId, 'run.recovery.terminal_ignored', actor, { status: run.status })
      return this.resultFor(run)
    }
    const task = await this.store.getTask(run.task_id)
    const classification: RecoveryAttempt['classification'] = run.status === 'awaiting_approval'
      ? 'AWAITING_APPROVAL'
      : run.status === 'executing' || run.status === 'verifying' ? 'VERIFY_REQUIRED' : 'SAFE_RESUME'
    const recovery: RecoveryAttempt = { recovery_id: this.createId(), run_id: runId, started_at: this.now(), classification, actor }
    await this.store.appendRecoveryAttempt(recovery)
    await this.audit.record(runId, 'run.recovery_started', actor, { recovery_id: recovery.recovery_id, classification, status: run.status })

    if (!task) return this.blockRecovery(run, recovery, 'Recovery cannot resume because the durable task is unavailable.')
    if (await this.store.isCancellationRequested(runId)) {
      this.cancelledRuns.add(runId)
      await this.audit.record(runId, 'run.cancellation_observed', actor, { recovery_id: recovery.recovery_id })
      if (!['executing', 'verifying'].includes(run.status)) {
        await this.completeRecovery(recovery, 'KNOWN_FAILURE')
        return this.finishCancelled(run, await this.store.getSteps(runId), task.idempotency_key)
      }
    }

    if (run.status === 'awaiting_approval') {
      const approval = await this.store.getApproval(runId)
      if (!approval || approval.status === 'pending') {
        await this.completeRecovery(recovery, 'UNKNOWN_REQUIRES_VERIFICATION')
        await this.audit.record(runId, 'run.recovery_completed', actor, { classification: 'AWAITING_APPROVAL', outcome: 'UNKNOWN_REQUIRES_VERIFICATION' })
        return this.resultFor(run)
      }
      if (approval.status === 'rejected') {
        await this.setRunStatus(run, 'blocked')
        await this.completeRecovery(recovery, 'KNOWN_FAILURE')
        return this.finish(run, await this.store.getSteps(runId), [{ code: 'APPROVAL_REJECTED', message: approval.reason ?? 'Approval was rejected.', retryability: 'non_retryable', step_id: approval.step_id }], task.idempotency_key)
      }
      if (this.approvalExpired(approval)) {
        if (approval.status === 'approved') {
          // Persisted status remains historical; effective expiry still blocks execution.
          await this.audit.record(runId, 'approval.expired', actor, { approval_id: approval.approval_id, step_id: approval.step_id })
        }
        await this.setRunStatus(run, 'expired')
        await this.completeRecovery(recovery, 'KNOWN_FAILURE')
        return this.finish(run, await this.store.getSteps(runId), [{ code: 'APPROVAL_EXPIRED', message: 'Approval expired before execution.', retryability: 'non_retryable', step_id: approval.step_id }], task.idempotency_key)
      }
      await this.setRunStatus(run, 'executing')
    }

    if (run.status === 'queued') await this.setRunStatus(run, 'validating')
    if (run.status === 'validating') await this.setRunStatus(run, 'planning')
    let steps = await this.store.getSteps(runId)
    if (run.status === 'planning') {
      if (!steps.length) {
        steps = this.planner.plan(task, runId)
        for (const step of steps) await this.store.saveStep(step)
      }
      const gated = await this.applyPolicyAndApproval(task, run, steps)
      if (gated) { await this.completeRecovery(recovery, gated.status === 'awaiting_approval' ? 'UNKNOWN_REQUIRES_VERIFICATION' : 'KNOWN_FAILURE'); return gated }
      await this.setRunStatus(run, 'executing')
    }

    const lease = await this.recoverLease(task, run, actor)
    if (!lease) return this.blockRecovery(run, recovery, 'The idempotency claim is live, completed, or owned by another recovery worker.')

    steps = await this.store.getSteps(runId)
    for (const step of steps) {
      if (step.status === 'succeeded' || step.status === 'skipped') continue
      if (await this.cancelled(runId) && step.status !== 'executing' && step.status !== 'verifying') {
        if (!['failed', 'blocked'].includes(step.status)) await this.moveStepToSkipped(step)
        await this.completeRecovery(recovery, 'KNOWN_FAILURE')
        return this.finishCancelled(run, steps, task.idempotency_key, { code: 'CANCELLED', message: 'Durable cancellation prevented a new side effect.', retryability: 'non_retryable', step_id: step.step_id }, lease)
      }
      if ((step.status === 'executing' || step.status === 'verifying') && step.risk_level > 0) {
        const outcome = await this.verifyInterrupted(task, run, step, lease)
        if (outcome) { await this.completeRecovery(recovery, outcome.recovery); return outcome.result }
        continue
      }
      if (step.status === 'executing' && step.risk_level === 0) await this.setStepStatus(step, 'retryable_failure')
      const failure = await this.executeStep(task, run, step, lease)
      if (!failure && await this.cancelled(runId)) {
        await this.completeRecovery(recovery, 'KNOWN_SUCCESS')
        return this.finishCancelled(run, steps, task.idempotency_key, undefined, lease)
      }
      if (failure) {
        await this.completeRecovery(recovery, failure.code === 'UNKNOWN_OUTCOME' ? 'RECOVERY_BLOCKED' : 'KNOWN_FAILURE')
        return failure.code === 'CANCELLED'
          ? this.finishCancelled(run, steps, task.idempotency_key, failure, lease)
          : this.finishFailure(run, steps, [failure], task.idempotency_key, lease)
      }
    }
    if (run.status === 'executing') await this.setRunStatus(run, 'verifying')
    if (await this.cancelled(runId)) {
      await this.completeRecovery(recovery, 'KNOWN_SUCCESS')
      return this.finishCancelled(run, steps, task.idempotency_key, undefined, lease)
    }
    await this.setRunStatus(run, 'completed')
    await this.completeRecovery(recovery, 'KNOWN_SUCCESS')
    await this.audit.record(runId, 'run.recovery_completed', actor, { recovery_id: recovery.recovery_id, outcome: 'KNOWN_SUCCESS' })
    return this.finish(run, steps, [], task.idempotency_key, lease)
  }

  async recoverAll(actor = 'recovery'): Promise<DeliveryResult[]> {
    const results: DeliveryResult[] = []
    for (const run of await this.store.listRecoverableRuns()) results.push(await this.recover(run.run_id, actor))
    return results
  }

  async execute(rawTask: unknown): Promise<DeliveryResult> {
    const createdAt = this.now()
    const run: Run = { run_id: this.createId(), task_id: 'unresolved', status: 'queued', started_at: createdAt, attempt: 1 }
    await this.store.saveRun(run)
    await this.audit.record(run.run_id, 'run.created', 'runner-os')
    await this.options.onRunCreated?.(run.run_id, this)
    await this.setRunStatus(run, 'validating')

    let task: Task
    try { task = normalizeTask(rawTask, createdAt, this.createId); validateTask(task) }
    catch (error) { return this.finishFailure(run, [], [validationError(error)], '') }

    const ownerToken = this.createId()
    const claim = await this.store.claimIdempotency(task.idempotency_key, run.run_id, createdAt, ownerToken, this.leaseExpiry())
    if (!claim.claimed) {
      await this.audit.record(run.run_id, 'run.duplicate_suppressed', task.requested_by, { idempotency_key: task.idempotency_key, owner_run_id: claim.owner_run_id, claim_state: claim.state })
      await this.setRunStatus(run, 'failed')
      run.finished_at = this.now()
      run.error = { code: 'DUPLICATE_IDEMPOTENCY_KEY', message: 'Duplicate task execution was suppressed.', retryability: 'non_retryable' }
      await this.store.saveRun(run)
      return claim.result ?? createDeliveryResult(run, [], [], [run.error], ['The original request is still in progress.'])
    }
    await this.audit.record(run.run_id, 'idempotency.claim_acquired', 'runner-os', { idempotency_key: task.idempotency_key, lease_expires_at: claim.lease_expires_at })

    await this.store.saveTask(task)
    run.task_id = task.task_id
    await this.store.saveRun(run)
    await this.audit.record(run.run_id, 'task.validated', task.requested_by, { task_id: task.task_id, task_type: task.type })
    if (await this.cancelled(run.run_id)) return this.finishCancelled(run, [], task.idempotency_key, undefined, ownerToken)

    await this.setRunStatus(run, 'planning')
    let steps: Step[]
    try {
      steps = this.planner.plan(task, run.run_id)
      if (!steps.length) throw new Error('Planner returned no executable steps.')
      for (const step of steps) await this.store.saveStep(step)
      await this.audit.record(run.run_id, 'plan.created', 'runner-os', { step_count: steps.length })
    } catch (error) {
      return this.finishFailure(run, [], [{ code: 'PLANNING_ERROR', message: safeMessage(error), retryability: 'non_retryable' }], task.idempotency_key, ownerToken)
    }

    const gated = await this.applyPolicyAndApproval(task, run, steps, ownerToken)
    if (gated) return gated
    if (await this.cancelled(run.run_id)) return this.finishCancelled(run, steps, task.idempotency_key, undefined, ownerToken)
    await this.setRunStatus(run, 'executing')

    for (const step of steps) {
      const failure = await this.executeStep(task, run, step, ownerToken)
      if (failure) return failure.code === 'CANCELLED'
        ? this.finishCancelled(run, steps, task.idempotency_key, failure, ownerToken)
        : this.finishFailure(run, steps, [failure], task.idempotency_key, ownerToken)
      if (await this.cancelled(run.run_id)) return this.finishCancelled(run, steps, task.idempotency_key, undefined, ownerToken)
    }
    await this.setRunStatus(run, 'verifying')
    await this.audit.record(run.run_id, 'run.verification_completed', 'runner-os', { verified_steps: steps.length })
    await this.setRunStatus(run, 'completed')
    return this.finish(run, steps, [], task.idempotency_key, ownerToken)
  }

  private async applyPolicyAndApproval(task: Task, run: Run, steps: Step[], ownerToken?: string): Promise<DeliveryResult | undefined> {
    for (const step of steps) {
      const durable = await this.importLegacyApproval(task, run, step)
      const context = durable ? { ...task.policy_context, approvals: [this.asSubmittedApproval(durable)] } : { ...task.policy_context, approvals: [] }
      const decision = this.policy.evaluate(step, context)
      step.policy_decision = decision; run.policy_decision = decision
      await this.store.saveStep(step); await this.store.saveRun(run)
      await this.audit.record(run.run_id, 'policy.evaluated', 'runner-os', { step_id: step.step_id, decision })
      if (durable?.status === 'expired' || (durable?.status === 'approved' && this.approvalExpired(durable))) {
        await this.setRunStatus(run, 'expired')
        await this.audit.record(run.run_id, 'approval.expired', 'runner-os', { approval_id: durable.approval_id, step_id: step.step_id })
        return this.finish(run, steps, [{ code: 'APPROVAL_EXPIRED', message: 'Approval expired before execution.', retryability: 'non_retryable', step_id: step.step_id }], task.idempotency_key)
      }
      if (decision.decision === 'DENY') {
        await this.setStepStatus(step, 'blocked'); await this.setRunStatus(run, 'blocked')
        return this.finish(run, steps, [{ code: 'POLICY_DENIED', message: decision.reason, retryability: 'non_retryable', step_id: step.step_id }], task.idempotency_key)
      }
      if (decision.decision === 'REQUIRE_APPROVAL') {
        const approval = await this.store.createApproval({ approval_id: `${run.run_id}:approval:${step.sequence}`, run_id: run.run_id, step_id: step.step_id,
          requested_action: step.action, risk_level: step.risk_level, status: 'pending', requested_at: this.now() })
        await this.setRunStatus(run, 'awaiting_approval')
        const result = createDeliveryResult(run, await this.store.getSteps(run.run_id), await this.store.getEvidence(run.run_id), [], [decision.reason])
        run.result = result; await this.store.saveRun(run)
        if (ownerToken) await this.store.renewIdempotencyLease(task.idempotency_key, run.run_id, ownerToken, this.now(), this.now())
        await this.audit.record(run.run_id, 'approval.requested', 'runner-os', { approval_id: approval.approval_id, step_id: step.step_id, requested_action: step.action, risk_level: step.risk_level })
        return result
      }
    }
    return undefined
  }

  private async importLegacyApproval(task: Task, run: Run, step: Step): Promise<ApprovalRecord | undefined> {
    const existing = await this.store.getApproval(run.run_id, step.step_id)
    if (existing) return existing
    const legacy = task.policy_context.approvals?.find((item) => item.requested_action === step.action && item.risk_level === step.risk_level && (!item.run_id || item.run_id === run.run_id) && (!item.step_id || item.step_id === step.step_id))
    if (!legacy) return undefined
    const expired = Boolean(legacy.expires_at && legacy.expires_at <= this.now())
    const approval = await this.store.createApproval({ approval_id: legacy.approval_id, run_id: run.run_id, step_id: step.step_id,
      requested_action: step.action, risk_level: step.risk_level, status: expired ? 'expired' : legacy.decision === 'APPROVED' ? 'approved' : 'rejected',
      requested_at: legacy.timestamp, decided_at: legacy.timestamp, approver: legacy.approver, expires_at: legacy.expires_at })
    await this.audit.record(run.run_id, `approval.${approval.status}`, approval.approver ?? 'legacy-approver', { approval_id: approval.approval_id, step_id: step.step_id, imported: true })
    return approval
  }

  private async executeStep(task: Task, run: Run, step: Step, ownerToken: string): Promise<RunnerError | undefined> {
    if (step.status === 'pending') await this.setStepStatus(step, 'validating')
    const adapter = this.adapters.resolve(step.tool)
    if (!adapter) { await this.setStepStatus(step, 'failed'); return { code: 'ADAPTER_UNAVAILABLE', message: `Adapter not registered: ${step.tool}`, retryability: 'non_retryable', step_id: step.step_id } }
    const contextFor = (attempt: number) => ({ run_id: run.run_id, step_id: step.step_id, idempotency_key: step.idempotency_key, attempt, is_cancelled: () => this.cancelledRuns.has(run.run_id) })
    if (step.status === 'validating') {
      try { await adapter.validate(redact(step.input), contextFor(0)) }
      catch (error) { await this.setStepStatus(step, 'failed'); return { code: 'VALIDATION_ERROR', message: safeMessage(error), retryability: 'non_retryable', step_id: step.step_id } }
      await this.setStepStatus(step, 'executing')
    } else if (step.status === 'retryable_failure') await this.setStepStatus(step, 'executing')

    step.started_at ??= this.now()
    const startedMs = this.nowMs()
    let execution: AdapterExecutionResult | undefined
    const firstAttempt = Math.max(1, step.attempt + 1)
    for (let attempt = firstAttempt; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      step.attempt = attempt; await this.store.saveStep(step)
      if (await this.cancelled(run.run_id)) { await this.setStepStatus(step, 'skipped'); return { code: 'CANCELLED', message: 'Execution cancelled before the next side effect.', retryability: 'non_retryable', step_id: step.step_id, attempt } }
      const retryDecision = await this.effectivePolicy(task, step)
      await this.audit.record(run.run_id, 'step.execution_started', 'runner-os', { step_id: step.step_id, attempt, policy_decision: retryDecision.decision })
      if (retryDecision.decision !== 'ALLOW') { await this.setStepStatus(step, 'failed'); return { code: 'POLICY_CHANGED', message: 'Policy or durable approval no longer allows execution.', retryability: 'non_retryable', step_id: step.step_id, attempt } }
      if (!await this.renewLease(task, run, ownerToken)) { await this.setStepStatus(step, 'failed'); return { code: 'IDEMPOTENCY_LEASE_LOST', message: 'Execution lease is no longer owned by this run.', retryability: 'unknown', step_id: step.step_id, attempt } }
      try { execution = await adapter.execute(redact(step.input), contextFor(attempt)) }
      catch (error) { execution = { success: false, provider: adapter.name, operation: step.action, error: { code: 'UNKNOWN_PROVIDER_ERROR', message: safeMessage(error), retryability: 'unknown', step_id: step.step_id, attempt }, retryability: 'unknown' } }
      await this.persistExecutionEvidence(run, step, execution)
      await this.audit.record(run.run_id, 'step.observed', adapter.name, { step_id: step.step_id, attempt, result: execution })
      if (execution.success) break
      if (execution.error?.code === 'CANCELLED' || await this.cancelled(run.run_id)) { await this.setStepStatus(step, 'skipped'); return { code: 'CANCELLED', message: 'Execution cancellation was observed; provider rollback is not claimed.', retryability: 'non_retryable', step_id: step.step_id, attempt } }
      if (execution.retryability === 'unknown') return this.verifyUnknownOutcome(adapter, run, step, execution, contextFor(attempt))
      if (!shouldRetry(execution, attempt, this.retryPolicy, adapter.capabilities().idempotency_supported)) {
        await this.setStepStatus(step, 'failed')
        return execution.retryability === 'retryable' && attempt >= this.retryPolicy.maxAttempts
          ? { code: 'RETRY_BUDGET_EXHAUSTED', message: 'Retry budget exhausted.', retryability: 'non_retryable', step_id: step.step_id, attempt }
          : { ...(execution.error ?? { code: 'TOOL_FAILURE', message: 'Tool execution failed.', retryability: execution.retryability }), step_id: step.step_id, attempt }
      }
      await this.setStepStatus(step, 'retryable_failure')
      await this.audit.record(run.run_id, 'step.retry_scheduled', 'runner-os', { step_id: step.step_id, attempt, next_attempt: attempt + 1 })
      await this.sleep(retryDelay(attempt, this.retryPolicy)); await this.setStepStatus(step, 'executing')
    }
    if (!execution?.success) { await this.setStepStatus(step, 'failed'); return { code: 'RETRY_BUDGET_EXHAUSTED', message: 'Retry budget exhausted.', retryability: 'non_retryable', step_id: step.step_id, attempt: step.attempt } }
    step.output = redact(execution.output ?? {}); step.finished_at = this.now(); step.duration_ms = Math.max(0, this.nowMs() - startedMs)
    await this.setStepStatus(step, 'verifying')
    const verification = await adapter.verify(execution, step.expected_outcome, contextFor(step.attempt))
    return this.finishVerification(run, step, adapter.name, verification)
  }

  private async verifyInterrupted(task: Task, run: Run, step: Step, ownerToken: string): Promise<{ recovery: RecoveryOutcome; result: DeliveryResult } | undefined> {
    const adapter = this.adapters.resolve(step.tool)
    if (!adapter?.capabilities().verification_supported) return this.recoveryBlockedResult(run, step, task, ownerToken, 'Adapter cannot verify an interrupted side effect.')
    step.recovery_outcome = 'UNKNOWN_REQUIRES_VERIFICATION'; run.recovery_outcome = 'UNKNOWN_REQUIRES_VERIFICATION'
    await this.store.saveStep(step); await this.store.saveRun(run)
    await this.audit.record(run.run_id, 'recovery.unknown_outcome_classified', 'recovery', { step_id: step.step_id, classification: step.recovery_outcome })
    if (step.status === 'executing') await this.setStepStatus(step, 'verifying')
    const execution = await this.executionFromEvidence(run.run_id, step)
    await this.audit.record(run.run_id, 'recovery.verification_attempted', adapter.name, { step_id: step.step_id })
    const verification = await adapter.verify(execution, step.expected_outcome, { run_id: run.run_id, step_id: step.step_id, idempotency_key: step.idempotency_key, attempt: step.attempt, is_cancelled: () => this.cancelledRuns.has(run.run_id) })
    step.verification_status = verification.status
    await this.persistVerificationEvidence(run, step, verification)
    await this.audit.record(run.run_id, 'recovery.verification_result', adapter.name, { step_id: step.step_id, verification })
    if (verification.status === 'PASS') {
      step.recovery_outcome = 'KNOWN_SUCCESS'; run.recovery_outcome = 'KNOWN_SUCCESS'; await this.setStepStatus(step, 'succeeded'); await this.store.saveRun(run)
      return undefined
    }
    if (verification.status === 'FAIL' && adapter.capabilities().idempotency_supported && !await this.cancelled(run.run_id) && (await this.effectivePolicy(task, step)).decision === 'ALLOW') {
      step.recovery_outcome = 'KNOWN_FAILURE'; await this.store.saveStep(step)
      await this.audit.record(run.run_id, 'recovery.retry_allowed', 'runner-os', { step_id: step.step_id, reason: 'Verification proved the side effect did not occur and idempotency/policy allow retry.' })
      await this.setStepStatus(step, 'retryable_failure')
      const failure = await this.executeStep(task, run, step, ownerToken)
      if (!failure) return undefined
      return { recovery: failure.code === 'UNKNOWN_OUTCOME' ? 'RECOVERY_BLOCKED' : 'KNOWN_FAILURE', result: await this.finishFailure(run, await this.store.getSteps(run.run_id), [failure], task.idempotency_key, ownerToken) }
    }
    await this.audit.record(run.run_id, 'recovery.retry_denied', 'runner-os', { step_id: step.step_id, verification_status: verification.status })
    return this.recoveryBlockedResult(run, step, task, ownerToken, verification.status === 'UNKNOWN' ? 'Verification remains inconclusive.' : 'Verification did not permit a safe retry.')
  }

  private async recoveryBlockedResult(run: Run, step: Step, task: Task, ownerToken: string, message: string): Promise<{ recovery: 'RECOVERY_BLOCKED'; result: DeliveryResult }> {
    step.recovery_outcome = 'RECOVERY_BLOCKED'; run.recovery_outcome = 'RECOVERY_BLOCKED'
    if (step.status === 'executing') await this.setStepStatus(step, 'verifying')
    if (step.status === 'verifying') await this.setStepStatus(step, 'failed')
    await this.setRunStatus(run, 'blocked')
    await this.audit.record(run.run_id, 'run.recovery_blocked', 'runner-os', { step_id: step.step_id, reason: message })
    return { recovery: 'RECOVERY_BLOCKED', result: await this.finish(run, await this.store.getSteps(run.run_id), [{ code: 'RECOVERY_BLOCKED', message, retryability: 'unknown', step_id: step.step_id }], task.idempotency_key, ownerToken) }
  }

  private async verifyUnknownOutcome(adapter: NonNullable<ReturnType<AdapterRegistry['resolve']>>, run: Run, step: Step, execution: AdapterExecutionResult, context: { run_id: string; step_id: string; idempotency_key: string; attempt: number; is_cancelled: () => boolean }): Promise<RunnerError | undefined> {
    step.recovery_outcome = 'UNKNOWN_REQUIRES_VERIFICATION'; run.recovery_outcome = 'UNKNOWN_REQUIRES_VERIFICATION'; await this.store.saveRun(run)
    await this.audit.record(run.run_id, 'outcome.unknown_classified', adapter.name, { step_id: step.step_id })
    await this.setStepStatus(step, 'verifying')
    const verification = await adapter.verify(execution, step.expected_outcome, context)
    step.verification_status = verification.status; await this.persistVerificationEvidence(run, step, verification)
    await this.audit.record(run.run_id, 'outcome.verification_result', adapter.name, { step_id: step.step_id, verification })
    if (verification.status === 'PASS') { step.recovery_outcome = 'KNOWN_SUCCESS'; run.recovery_outcome = 'KNOWN_SUCCESS'; await this.setStepStatus(step, 'succeeded'); await this.store.saveRun(run); return undefined }
    step.recovery_outcome = verification.status === 'FAIL' ? 'KNOWN_FAILURE' : 'RECOVERY_BLOCKED'; await this.setStepStatus(step, 'failed')
    return { code: 'UNKNOWN_OUTCOME', message: `Mutation was not retried because its outcome is unknown. ${verification.summary}`, retryability: 'unknown', step_id: step.step_id, attempt: step.attempt }
  }

  private async finishVerification(run: Run, step: Step, actor: string, verification: VerificationResult): Promise<RunnerError | undefined> {
    step.verification_status = verification.status; await this.persistVerificationEvidence(run, step, verification)
    await this.audit.record(run.run_id, 'step.verified', actor, { step_id: step.step_id, verification })
    if (verification.status !== 'PASS') { await this.setStepStatus(step, 'failed'); return { code: verification.status === 'UNKNOWN' ? 'VERIFICATION_UNKNOWN' : 'VERIFICATION_FAILED', message: verification.summary, retryability: 'non_retryable', step_id: step.step_id, attempt: step.attempt } }
    step.recovery_outcome = 'KNOWN_SUCCESS'; await this.setStepStatus(step, 'succeeded'); return undefined
  }

  private async effectivePolicy(task: Task, step: Step) {
    const approval = await this.store.getApproval(step.run_id, step.step_id)
    const approvals = approval?.status === 'approved' && !this.approvalExpired(approval) ? [this.asSubmittedApproval(approval)] : []
    return this.policy.evaluate(step, { ...task.policy_context, approvals })
  }
  private asSubmittedApproval(approval: ApprovalRecord) {
    return { approval_id: approval.approval_id, run_id: approval.run_id, step_id: approval.step_id, requested_action: approval.requested_action,
      risk_level: approval.risk_level, approver: approval.approver ?? 'unknown', decision: approval.status === 'approved' ? 'APPROVED' as const : 'REJECTED' as const,
      timestamp: approval.decided_at ?? approval.requested_at, expires_at: approval.expires_at }
  }
  private approvalExpired(approval: ApprovalRecord): boolean { return approval.status === 'expired' || Boolean(approval.expires_at && approval.expires_at <= this.now()) }

  private async recoverLease(task: Task, run: Run, actor: string): Promise<string | undefined> {
    const observed = await this.store.claimIdempotency(task.idempotency_key, run.run_id, this.now(), this.createId(), this.leaseExpiry())
    if (observed.claimed) { await this.audit.record(run.run_id, 'idempotency.claim_acquired', actor, { recovered: false }); return observed.owner_token }
    if (observed.state === 'completed') return undefined
    if (!observed.owner_token || !observed.lease_expires_at || observed.lease_expires_at > this.now()) return undefined
    const ownerToken = this.createId()
    const recovered = await this.store.recoverIdempotencyClaim(task.idempotency_key, run.run_id, observed.owner_token, ownerToken, this.now(), this.leaseExpiry())
    if (!recovered.claimed) return undefined
    await this.audit.record(run.run_id, 'idempotency.claim_recovered', actor, { previous_owner: observed.owner_run_id, lease_expires_at: recovered.lease_expires_at })
    return ownerToken
  }
  private async renewLease(task: Task, run: Run, ownerToken: string): Promise<boolean> {
    const now = this.now(); const renewed = await this.store.renewIdempotencyLease(task.idempotency_key, run.run_id, ownerToken, now, this.leaseExpiry())
    if (renewed) await this.audit.record(run.run_id, 'idempotency.claim_renewed', 'runner-os', { lease_expires_at: this.leaseExpiry() })
    return renewed
  }
  private leaseExpiry(): string { return new Date(Date.parse(this.now()) + this.leaseMs).toISOString() }

  private async executionFromEvidence(runId: string, step: Step): Promise<AdapterExecutionResult> {
    const evidence = (await this.store.getEvidence(runId)).filter((item) => item.step_id === step.step_id && item.type === 'execution').at(-1)
    const payload = evidence?.payload_reference ?? {}
    return { success: payload.success === true, provider: String(payload.provider ?? step.tool), operation: String(payload.operation ?? step.action),
      provider_request_id: typeof payload.provider_request_id === 'string' ? payload.provider_request_id : undefined,
      output: typeof payload.output === 'object' && payload.output ? payload.output as Record<string, unknown> : step.output,
      error: typeof payload.error === 'object' && payload.error ? payload.error as RunnerError : { code: 'INTERRUPTED', message: 'Runtime interrupted after the provider may have received the operation.', retryability: 'unknown', step_id: step.step_id },
      retryability: 'unknown', side_effect_reference: typeof payload.side_effect_reference === 'string' ? payload.side_effect_reference : undefined }
  }

  private async persistExecutionEvidence(run: Run, step: Step, execution: AdapterExecutionResult): Promise<void> {
    await this.appendEvidence(run, step, 'execution', execution.provider, redact({ success: execution.success, provider: execution.provider, operation: execution.operation,
      provider_request_id: execution.provider_request_id, output: execution.output, error: execution.error, side_effect_reference: execution.side_effect_reference }))
  }
  private async persistVerificationEvidence(run: Run, step: Step, verification: VerificationResult): Promise<void> {
    await this.appendEvidence(run, step, 'verification', step.tool, redact({ status: verification.status, summary: verification.summary, details: verification.details }))
  }
  private async appendEvidence(run: Run, step: Step, type: Evidence['type'], source: string, payload: Record<string, unknown>): Promise<void> {
    const evidence: Evidence = { evidence_id: this.createId(), run_id: run.run_id, step_id: step.step_id, type, source, payload_reference: payload, captured_at: this.now(), integrity_hash: integrityHash(payload) }
    await this.store.appendEvidence(evidence); await this.audit.record(run.run_id, 'evidence.persisted', 'runner-os', { evidence_id: evidence.evidence_id, step_id: step.step_id, type })
  }
  private async setRunStatus(run: Run, next: Run['status']): Promise<void> { run.status = transitionRun(run.status, next); await this.store.saveRun(run); await this.audit.record(run.run_id, 'run.status_changed', 'runner-os', { status: next }) }
  private async setStepStatus(step: Step, next: Step['status']): Promise<void> { step.status = transitionStep(step.status, next); await this.store.saveStep(step); await this.audit.record(step.run_id, 'step.status_changed', 'runner-os', { step_id: step.step_id, status: next }) }
  private async moveStepToSkipped(step: Step): Promise<void> {
    if (step.status === 'pending') return this.setStepStatus(step, 'skipped')
    if (step.status === 'validating') { await this.setStepStatus(step, 'executing'); return this.setStepStatus(step, 'skipped') }
    if (step.status === 'retryable_failure') { await this.setStepStatus(step, 'executing'); return this.setStepStatus(step, 'skipped') }
  }
  private async finishFailure(run: Run, steps: Step[], errors: RunnerError[], key: string, ownerToken?: string): Promise<DeliveryResult> {
    if (!['failed', 'blocked', 'cancelled', 'expired'].includes(run.status)) await this.setRunStatus(run, 'failed')
    run.error = errors[0]; return this.finish(run, steps, errors, key, ownerToken)
  }
  private async finishCancelled(run: Run, steps: Step[], key: string, error?: RunnerError, ownerToken?: string): Promise<DeliveryResult> {
    if (run.status !== 'cancelled') await this.setRunStatus(run, 'cancelled')
    await this.audit.record(run.run_id, 'run.cancellation_observed', 'runner-os', { uncertain_provider_continuation: steps.some((step) => step.recovery_outcome === 'UNKNOWN_REQUIRES_VERIFICATION' || step.recovery_outcome === 'RECOVERY_BLOCKED') })
    return this.finish(run, steps, error ? [error] : [], key, ownerToken)
  }
  private async finish(run: Run, steps: Step[], errors: RunnerError[], key: string, ownerToken?: string): Promise<DeliveryResult> {
    run.finished_at = this.now(); const current = steps.length ? await this.store.getSteps(run.run_id) : []
    const result = createDeliveryResult(run, current, await this.store.getEvidence(run.run_id), errors); run.result = result
    await this.store.saveRun(run); await this.audit.record(run.run_id, 'run.delivered', 'runner-os', { status: result.status, error_count: result.errors.length })
    if (key && run.status !== 'awaiting_approval') await this.store.saveIdempotentResult(key, result, ownerToken)
    return result
  }
  private async resultFor(run: Run): Promise<DeliveryResult> { return run.result ?? createDeliveryResult(run, await this.store.getSteps(run.run_id), await this.store.getEvidence(run.run_id), run.error ? [run.error] : []) }
  private async requiredRun(runId: string): Promise<Run> { const run = await this.store.getRun(runId); if (!run) throw new Error(`Run not found: ${runId}`); return run }
  private async cancelled(runId: string): Promise<boolean> { if (this.cancelledRuns.has(runId)) return true; const durable = await this.store.isCancellationRequested(runId); if (durable) this.cancelledRuns.add(runId); return durable }
  private async completeRecovery(recovery: RecoveryAttempt, outcome: RecoveryOutcome): Promise<void> { await this.store.completeRecoveryAttempt(recovery.recovery_id, this.now(), outcome) }
  private async blockRecovery(run: Run, recovery: RecoveryAttempt, message: string): Promise<DeliveryResult> {
    run.recovery_outcome = 'RECOVERY_BLOCKED'; await this.setRunStatus(run, 'blocked'); await this.completeRecovery(recovery, 'RECOVERY_BLOCKED')
    await this.audit.record(run.run_id, 'run.recovery_blocked', recovery.actor, { recovery_id: recovery.recovery_id, reason: message })
    return this.finish(run, await this.store.getSteps(run.run_id), [{ code: 'RECOVERY_BLOCKED', message, retryability: 'unknown' }], '')
  }
}

function validationError(error: unknown): RunnerError { return { code: 'VALIDATION_ERROR', message: error instanceof ContractValidationError ? error.message : safeMessage(error), retryability: 'non_retryable' } }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error' }
