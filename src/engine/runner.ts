import { AdapterRegistry } from '../adapters/registry'
import { ContractValidationError, normalizeTask, validateTask } from '../core/contracts'
import { integrityHash } from '../core/hash'
import { createDeliveryResult } from '../core/result'
import { transitionRun, transitionStep } from '../core/state-machine'
import type {
  AdapterExecutionResult, DeliveryResult, Evidence, Run, RunnerError, Step, Task,
} from '../core/types'
import { AuditRecorder } from '../observability/audit'
import type { RunnerStore } from '../persistence/store'
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
  sleep?: (milliseconds: number) => Promise<void>
  onRunCreated?: (runId: string, engine: RunnerEngine) => void
}

export class RunnerEngine {
  private readonly now: () => string
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly planner: Planner
  private readonly policy: PolicyEvaluator
  private readonly retryPolicy: RetryPolicy
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly audit: AuditRecorder
  private readonly cancelledRuns = new Set<string>()

  constructor(
    private readonly store: RunnerStore,
    private readonly adapters: AdapterRegistry,
    private readonly options: RunnerEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.nowMs = options.nowMs ?? (() => Date.now())
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.planner = options.planner ?? new DeterministicPlanner()
    this.policy = options.policy ?? new DefaultPolicyEvaluator(this.now)
    this.retryPolicy = { ...defaultRetryPolicy, ...options.retryPolicy }
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.audit = new AuditRecorder(store, this.now, this.createId)
  }

  cancel(runId: string, actor = 'system'): boolean {
    const run = this.store.getRun(runId)
    if (!run || ['completed', 'failed', 'cancelled', 'blocked', 'expired'].includes(run.status)) return false
    this.cancelledRuns.add(runId)
    this.audit.record(runId, 'run.cancellation_requested', actor)
    return true
  }

  async execute(rawTask: unknown): Promise<DeliveryResult> {
    const createdAt = this.now()
    const run: Run = {
      run_id: this.createId(),
      task_id: 'unresolved',
      status: 'queued',
      started_at: createdAt,
      attempt: 1,
    }
    this.store.saveRun(run)
    this.audit.record(run.run_id, 'run.created', 'runner-os')
    this.options.onRunCreated?.(run.run_id, this)

    this.setRunStatus(run, 'validating')
    let task: Task
    try {
      task = normalizeTask(rawTask, createdAt, this.createId)
      run.task_id = task.task_id
      this.store.saveRun(run)
      validateTask(task)
    } catch (error) {
      const runnerError = validationError(error)
      return this.finishFailure(run, [], [runnerError], '')
    }

    const existing = this.store.getIdempotentResult(task.idempotency_key)
    if (existing) {
      this.audit.record(run.run_id, 'run.duplicate_suppressed', task.requested_by, { idempotency_key: task.idempotency_key })
      this.setRunStatus(run, 'failed')
      run.finished_at = this.now()
      run.error = { code: 'DUPLICATE_IDEMPOTENCY_KEY', message: 'Duplicate task execution was suppressed.', retryability: 'non_retryable' }
      this.store.saveRun(run)
      return existing
    }

    this.store.saveTask(task)
    this.audit.record(run.run_id, 'task.validated', task.requested_by, { task_id: task.task_id, task_type: task.type })
    if (this.isCancelled(run.run_id)) return this.finishCancelled(run, [], task.idempotency_key)

    this.setRunStatus(run, 'planning')
    let steps: Step[]
    try {
      steps = this.planner.plan(task, run.run_id)
      if (!steps.length) throw new Error('Planner returned no executable steps.')
      steps.forEach((step) => this.store.saveStep(step))
      this.audit.record(run.run_id, 'plan.created', 'runner-os', { step_count: steps.length })
    } catch (error) {
      return this.finishFailure(run, [], [{ code: 'PLANNING_ERROR', message: safeMessage(error), retryability: 'non_retryable' }], task.idempotency_key)
    }

    for (const step of steps) {
      const decision = this.policy.evaluate(step, task.policy_context)
      step.policy_decision = decision
      run.policy_decision = decision
      this.store.saveStep(step)
      this.store.saveRun(run)
      this.audit.record(run.run_id, 'policy.evaluated', 'runner-os', { step_id: step.step_id, decision })
      if (decision.decision === 'DENY') {
        this.setStepStatus(step, 'blocked')
        this.setRunStatus(run, 'blocked')
        const error: RunnerError = { code: 'POLICY_DENIED', message: decision.reason, retryability: 'non_retryable', step_id: step.step_id }
        return this.finish(run, steps, [error], task.idempotency_key)
      }
      if (decision.decision === 'REQUIRE_APPROVAL') {
        this.setRunStatus(run, 'awaiting_approval')
        const result = createDeliveryResult(run, this.currentSteps(run.run_id), this.store.getEvidence(run.run_id), [], [decision.reason])
        run.result = result
        this.store.saveRun(run)
        this.audit.record(run.run_id, 'run.awaiting_approval', 'runner-os', { step_id: step.step_id })
        return result
      }
    }

    if (this.isCancelled(run.run_id)) return this.finishCancelled(run, steps, task.idempotency_key)
    this.setRunStatus(run, 'executing')

    for (const step of steps) {
      const failure = await this.executeStep(task, run, step)
      if (failure) {
        if (failure.code === 'CANCELLED') return this.finishCancelled(run, steps, task.idempotency_key, failure)
        return this.finishFailure(run, steps, [failure], task.idempotency_key)
      }
    }

    this.setRunStatus(run, 'verifying')
    this.audit.record(run.run_id, 'run.verification_completed', 'runner-os', { verified_steps: steps.length })
    this.setRunStatus(run, 'completed')
    return this.finish(run, steps, [], task.idempotency_key)
  }

  private async executeStep(task: Task, run: Run, step: Step): Promise<RunnerError | undefined> {
    this.setStepStatus(step, 'validating')
    const adapter = this.adapters.resolve(step.tool)
    if (!adapter) {
      this.setStepStatus(step, 'failed')
      return { code: 'ADAPTER_UNAVAILABLE', message: `Adapter not registered: ${step.tool}`, retryability: 'non_retryable', step_id: step.step_id }
    }

    const contextFor = (attempt: number) => ({
      run_id: run.run_id,
      step_id: step.step_id,
      idempotency_key: step.idempotency_key,
      attempt,
      is_cancelled: () => this.isCancelled(run.run_id),
    })

    try {
      await adapter.validate(redact(step.input), contextFor(0))
    } catch (error) {
      this.setStepStatus(step, 'failed')
      return { code: 'VALIDATION_ERROR', message: safeMessage(error), retryability: 'non_retryable', step_id: step.step_id }
    }

    this.setStepStatus(step, 'executing')
    step.started_at = this.now()
    const startedMs = this.nowMs()
    let execution: AdapterExecutionResult | undefined

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      step.attempt = attempt
      this.store.saveStep(step)
      if (this.isCancelled(run.run_id)) {
        this.setStepStatus(step, 'skipped')
        return { code: 'CANCELLED', message: 'Execution cancelled before the next side effect.', retryability: 'non_retryable', step_id: step.step_id, attempt }
      }

      const retryDecision = this.policy.evaluate(step, task.policy_context)
      this.audit.record(run.run_id, 'step.execution_started', 'runner-os', { step_id: step.step_id, attempt, policy_decision: retryDecision.decision })
      if (retryDecision.decision !== 'ALLOW') {
        this.setStepStatus(step, 'failed')
        return { code: 'POLICY_CHANGED', message: 'Policy no longer allows execution.', retryability: 'non_retryable', step_id: step.step_id, attempt }
      }

      try {
        execution = await adapter.execute(redact(step.input), contextFor(attempt))
      } catch (error) {
        execution = {
          success: false,
          provider: adapter.name,
          operation: step.action,
          error: { code: 'UNKNOWN_PROVIDER_ERROR', message: safeMessage(error), retryability: 'unknown', step_id: step.step_id, attempt },
          retryability: 'unknown',
        }
      }

      this.persistExecutionEvidence(run, step, execution)
      this.audit.record(run.run_id, 'step.observed', adapter.name, { step_id: step.step_id, attempt, result: execution })

      if (execution.success) break
      if (execution.error?.code === 'CANCELLED' || this.isCancelled(run.run_id)) {
        this.setStepStatus(step, 'skipped')
        return { code: 'CANCELLED', message: 'Execution cancelled while the adapter was running.', retryability: 'non_retryable', step_id: step.step_id, attempt }
      }
      if (execution.retryability === 'unknown') {
        return this.verifyUnknownOutcome(adapter, run, step, execution, contextFor(attempt))
      }
      if (!shouldRetry(execution, attempt, this.retryPolicy, adapter.capabilities().idempotency_supported)) {
        this.setStepStatus(step, 'failed')
        if (execution.retryability === 'retryable' && attempt >= this.retryPolicy.maxAttempts) {
          return { code: 'RETRY_BUDGET_EXHAUSTED', message: 'Retry budget exhausted.', retryability: 'non_retryable', step_id: step.step_id, attempt }
        }
        return { ...(execution.error ?? { code: 'TOOL_FAILURE', message: 'Tool execution failed.', retryability: execution.retryability }), step_id: step.step_id, attempt }
      }

      this.setStepStatus(step, 'retryable_failure')
      this.audit.record(run.run_id, 'step.retry_scheduled', 'runner-os', { step_id: step.step_id, attempt, next_attempt: attempt + 1 })
      await this.sleep(retryDelay(attempt, this.retryPolicy))
      this.setStepStatus(step, 'executing')
    }

    if (!execution?.success) {
      this.setStepStatus(step, 'failed')
      return { code: 'RETRY_BUDGET_EXHAUSTED', message: 'Retry budget exhausted.', retryability: 'non_retryable', step_id: step.step_id, attempt: step.attempt }
    }

    step.output = redact(execution.output ?? {})
    step.finished_at = this.now()
    step.duration_ms = Math.max(0, this.nowMs() - startedMs)
    this.setStepStatus(step, 'verifying')
    const verification = await adapter.verify(execution, step.expected_outcome, contextFor(step.attempt))
    step.verification_status = verification.status
    this.persistVerificationEvidence(run, step, verification)
    this.audit.record(run.run_id, 'step.verified', adapter.name, { step_id: step.step_id, verification })

    if (verification.status !== 'PASS') {
      this.setStepStatus(step, 'failed')
      return {
        code: verification.status === 'UNKNOWN' ? 'VERIFICATION_UNKNOWN' : 'VERIFICATION_FAILED',
        message: verification.summary,
        retryability: 'non_retryable',
        step_id: step.step_id,
        attempt: step.attempt,
      }
    }

    this.setStepStatus(step, 'succeeded')
    return undefined
  }

  private async verifyUnknownOutcome(
    adapter: NonNullable<ReturnType<AdapterRegistry['resolve']>>,
    run: Run,
    step: Step,
    execution: AdapterExecutionResult,
    context: ReturnType<typeof contextShape>,
  ): Promise<RunnerError> {
    this.setStepStatus(step, 'verifying')
    const verification = await adapter.verify(execution, step.expected_outcome, context)
    step.verification_status = verification.status
    this.persistVerificationEvidence(run, step, verification)
    this.audit.record(run.run_id, 'step.unknown_outcome_verified', adapter.name, { step_id: step.step_id, verification })
    this.setStepStatus(step, 'failed')
    return {
      code: 'UNKNOWN_OUTCOME',
      message: `Mutation was not retried because its outcome is unknown. ${verification.summary}`,
      retryability: 'unknown',
      step_id: step.step_id,
      attempt: step.attempt,
    }
  }

  private persistExecutionEvidence(run: Run, step: Step, execution: AdapterExecutionResult): void {
    const payload = redact({
      success: execution.success,
      provider: execution.provider,
      operation: execution.operation,
      provider_request_id: execution.provider_request_id,
      output: execution.output,
      error: execution.error,
      side_effect_reference: execution.side_effect_reference,
    })
    this.appendEvidence(run, step, 'execution', execution.provider, payload)
  }

  private persistVerificationEvidence(run: Run, step: Step, verification: { status: string; summary: string; details?: Record<string, unknown> }): void {
    this.appendEvidence(run, step, 'verification', step.tool, redact({
      status: verification.status,
      summary: verification.summary,
      details: verification.details,
    }))
  }

  private appendEvidence(run: Run, step: Step, type: Evidence['type'], source: string, payload: Record<string, unknown>): void {
    const evidence: Evidence = {
      evidence_id: this.createId(),
      run_id: run.run_id,
      step_id: step.step_id,
      type,
      source,
      payload_reference: payload,
      captured_at: this.now(),
      integrity_hash: integrityHash(payload),
    }
    this.store.appendEvidence(evidence)
    this.audit.record(run.run_id, 'evidence.persisted', 'runner-os', { evidence_id: evidence.evidence_id, step_id: step.step_id, type })
  }

  private setRunStatus(run: Run, next: Run['status']): void {
    run.status = transitionRun(run.status, next)
    this.store.saveRun(run)
    this.audit.record(run.run_id, 'run.status_changed', 'runner-os', { status: next })
  }

  private setStepStatus(step: Step, next: Step['status']): void {
    step.status = transitionStep(step.status, next)
    this.store.saveStep(step)
    this.audit.record(step.run_id, 'step.status_changed', 'runner-os', { step_id: step.step_id, status: next })
  }

  private finishFailure(run: Run, steps: Step[], errors: RunnerError[], idempotencyKey: string): DeliveryResult {
    if (!['failed', 'blocked', 'cancelled'].includes(run.status)) this.setRunStatus(run, 'failed')
    run.error = errors[0]
    return this.finish(run, steps, errors, idempotencyKey)
  }

  private finishCancelled(run: Run, steps: Step[], idempotencyKey: string, error?: RunnerError): DeliveryResult {
    if (run.status !== 'cancelled') this.setRunStatus(run, 'cancelled')
    return this.finish(run, steps, error ? [error] : [], idempotencyKey)
  }

  private finish(run: Run, steps: Step[], errors: RunnerError[], idempotencyKey: string): DeliveryResult {
    run.finished_at = this.now()
    const current = steps.length ? this.currentSteps(run.run_id) : []
    const result = createDeliveryResult(run, current, this.store.getEvidence(run.run_id), errors)
    run.result = result
    this.store.saveRun(run)
    this.audit.record(run.run_id, 'run.delivered', 'runner-os', { status: result.status, error_count: result.errors.length })
    if (idempotencyKey && run.status !== 'awaiting_approval') this.store.saveIdempotentResult(idempotencyKey, result)
    return result
  }

  private currentSteps(runId: string): Step[] { return this.store.getSteps(runId) }
  private isCancelled(runId: string): boolean { return this.cancelledRuns.has(runId) }
}

function contextShape() {
  return { run_id: '', step_id: '', idempotency_key: '', attempt: 0, is_cancelled: () => false }
}

function validationError(error: unknown): RunnerError {
  return {
    code: 'VALIDATION_ERROR',
    message: error instanceof ContractValidationError ? error.message : safeMessage(error),
    retryability: 'non_retryable',
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
