import { stableStringify } from '../core/hash'
import { redact, redactFreeText } from '../security/redaction'
import type { ApprovalRecord, AuditEvent, DeliveryResult, Evidence, RecoveryOutcome, Run, Step, Task } from '../core/types'
import type { IdempotencyClaim, RecoveryAttempt, RunnerStore } from './store'

type Row = Record<string, unknown>
const json = (value: unknown): string => stableStringify(value)
const nullableJson = (value: unknown): string | null => value === undefined ? null : json(value)
const parse = <T>(value: unknown): T | undefined => typeof value === 'string' && value.length > 0 ? JSON.parse(value) as T : undefined
const text = (value: unknown): string => String(value)
const optionalText = (value: unknown): string | undefined => value === null || value === undefined ? undefined : text(value)

export class D1RunnerStore implements RunnerStore {
  constructor(private readonly db: D1Database) {}

  async saveTask(task: Task): Promise<void> {
    const safe = redact(task)
    await this.db.prepare(`INSERT INTO tasks (
      task_id,idempotency_key,type,objective,input_json,constraints_json,risk_level,requested_at,requested_by,policy_context_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      type=excluded.type,objective=excluded.objective,input_json=excluded.input_json,constraints_json=excluded.constraints_json,
      risk_level=excluded.risk_level,requested_at=excluded.requested_at,requested_by=excluded.requested_by,policy_context_json=excluded.policy_context_json`)
      .bind(safe.task_id, safe.idempotency_key, safe.type, safe.objective, json(safe.input), json(safe.constraints), safe.risk_level,
        safe.requested_at, safe.requested_by, json(safe.policy_context)).run()
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const row = await this.db.prepare('SELECT * FROM tasks WHERE task_id=?').bind(taskId).first<Row>()
    if (!row) return undefined
    return {
      task_id: text(row.task_id), type: text(row.type), objective: text(row.objective), input: parse<Task['input']>(row.input_json) ?? { steps: [] },
      constraints: parse(row.constraints_json) ?? {}, risk_level: Number(row.risk_level) as Task['risk_level'], requested_at: text(row.requested_at),
      requested_by: text(row.requested_by), policy_context: parse(row.policy_context_json) ?? {}, idempotency_key: text(row.idempotency_key),
    }
  }

  async saveRun(run: Run): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO runs (
      run_id,task_id,status,started_at,finished_at,attempt,policy_decision_json,result_json,error_json,updated_at,
      cancellation_requested_at,cancellation_requested_by,recovery_outcome
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      task_id=excluded.task_id,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,
      attempt=excluded.attempt,policy_decision_json=excluded.policy_decision_json,result_json=excluded.result_json,
      error_json=excluded.error_json,updated_at=excluded.updated_at,
      cancellation_requested_at=COALESCE(runs.cancellation_requested_at,excluded.cancellation_requested_at),
      cancellation_requested_by=COALESCE(runs.cancellation_requested_by,excluded.cancellation_requested_by),recovery_outcome=excluded.recovery_outcome
    WHERE runs.status NOT IN ('completed','failed','cancelled','blocked','expired') OR runs.status=excluded.status`)
      .bind(run.run_id, run.task_id === 'unresolved' ? null : run.task_id, run.status, run.started_at, run.finished_at ?? null,
        run.attempt, nullableJson(run.policy_decision), nullableJson(redact(run.result)), nullableJson(redact(run.error)), new Date().toISOString(),
        run.cancellation_requested_at ?? null, run.cancellation_requested_by ?? null, run.recovery_outcome ?? null).run()
    if ((result.meta.changes ?? 0) === 0) throw new Error(`Rejected transition from terminal run ${run.run_id}.`)
  }

  async saveStep(step: Step): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO steps (
      step_id,run_id,sequence,tool,action,input_json,expected_outcome_json,risk_level,status,attempt,idempotency_key,
      started_at,finished_at,duration_ms,output_json,error_json,verification_status,policy_decision_json,recovery_outcome
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(step_id) DO UPDATE SET
      sequence=excluded.sequence,tool=excluded.tool,action=excluded.action,input_json=excluded.input_json,
      expected_outcome_json=excluded.expected_outcome_json,risk_level=excluded.risk_level,status=excluded.status,
      attempt=excluded.attempt,started_at=excluded.started_at,finished_at=excluded.finished_at,duration_ms=excluded.duration_ms,
      output_json=excluded.output_json,error_json=excluded.error_json,verification_status=excluded.verification_status,
      policy_decision_json=excluded.policy_decision_json,recovery_outcome=excluded.recovery_outcome
    WHERE steps.status NOT IN ('succeeded','failed','blocked','skipped') OR steps.status=excluded.status`)
      .bind(step.step_id, step.run_id, step.sequence, step.tool, step.action, json(redact(step.input)), nullableJson(redact(step.expected_outcome)),
        step.risk_level, step.status, step.attempt, step.idempotency_key, step.started_at ?? null, step.finished_at ?? null,
        step.duration_ms ?? null, nullableJson(redact(step.output)), nullableJson(redact(step.error)), step.verification_status,
        nullableJson(step.policy_decision), step.recovery_outcome ?? null).run()
    if ((result.meta.changes ?? 0) === 0) throw new Error(`Rejected transition from terminal step ${step.step_id}.`)
  }

  async appendEvidence(evidence: Evidence): Promise<void> {
    await this.db.prepare(`INSERT INTO evidence (evidence_id,run_id,step_id,type,source,payload_reference_json,captured_at,integrity_hash)
      VALUES (?,?,?,?,?,?,?,?)`).bind(evidence.evidence_id, evidence.run_id, evidence.step_id, evidence.type, evidence.source,
      json(redact(evidence.payload_reference)), evidence.captured_at, evidence.integrity_hash).run()
  }
  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.prepare(`INSERT INTO audit_events (event_id,run_id,timestamp,event_type,actor,metadata_json) VALUES (?,?,?,?,?,?)`)
      .bind(event.event_id, event.run_id, event.timestamp, event.event_type, event.actor, json(redact(event.metadata))).run()
  }
  async getRun(runId: string): Promise<Run | undefined> {
    const row = await this.db.prepare('SELECT * FROM runs WHERE run_id=?').bind(runId).first<Row>()
    return row ? this.runFrom(row) : undefined
  }
  async getSteps(runId: string): Promise<Step[]> {
    const rows = await this.db.prepare('SELECT * FROM steps WHERE run_id=? ORDER BY sequence').bind(runId).all<Row>()
    return rows.results.map((row) => this.stepFrom(row))
  }
  async getEvidence(runId: string): Promise<Evidence[]> {
    const rows = await this.db.prepare('SELECT * FROM evidence WHERE run_id=? ORDER BY captured_at,evidence_id').bind(runId).all<Row>()
    return rows.results.map((row) => ({ evidence_id: text(row.evidence_id), run_id: text(row.run_id), step_id: text(row.step_id),
      type: text(row.type) as Evidence['type'], source: text(row.source), payload_reference: parse(row.payload_reference_json) ?? {},
      captured_at: text(row.captured_at), integrity_hash: text(row.integrity_hash) }))
  }
  async getAudit(runId: string): Promise<AuditEvent[]> {
    const rows = await this.db.prepare('SELECT * FROM audit_events WHERE run_id=? ORDER BY timestamp,event_id').bind(runId).all<Row>()
    return rows.results.map((row) => ({ event_id: text(row.event_id), run_id: text(row.run_id), timestamp: text(row.timestamp),
      event_type: text(row.event_type), actor: text(row.actor), metadata: parse(row.metadata_json) ?? {} }))
  }

  async claimIdempotency(key: string, runId: string, claimedAt: string, ownerToken = runId, leaseExpiresAt = claimedAt): Promise<IdempotencyClaim> {
    const inserted = await this.db.prepare(`INSERT OR IGNORE INTO idempotency_claims
      (idempotency_key,run_id,state,result_json,claimed_at,owner_token,lease_expires_at,heartbeat_at)
      VALUES (?,?,'claimed',NULL,?,?,?,?)`).bind(key, runId, claimedAt, ownerToken, leaseExpiresAt, claimedAt).run()
    if ((inserted.meta.changes ?? 0) > 0) return { claimed: true, owner_run_id: runId, owner_token: ownerToken, state: 'claimed', lease_expires_at: leaseExpiresAt }
    return this.idempotencyClaim(key)
  }
  async renewIdempotencyLease(key: string, runId: string, ownerToken: string, heartbeatAt: string, leaseExpiresAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE idempotency_claims SET heartbeat_at=?,lease_expires_at=?
      WHERE idempotency_key=? AND run_id=? AND owner_token=? AND state='claimed' AND lease_expires_at>=?`)
      .bind(heartbeatAt, leaseExpiresAt, key, runId, ownerToken, heartbeatAt).run()
    return (result.meta.changes ?? 0) > 0
  }
  async recoverIdempotencyClaim(key: string, runId: string, previousOwnerToken: string, ownerToken: string, recoveredAt: string, leaseExpiresAt: string): Promise<IdempotencyClaim> {
    const result = await this.db.prepare(`UPDATE idempotency_claims SET owner_token=?,heartbeat_at=?,lease_expires_at=?,recovered_at=?
      WHERE idempotency_key=? AND run_id=? AND owner_token=? AND state='claimed' AND lease_expires_at<=?`)
      .bind(ownerToken, recoveredAt, leaseExpiresAt, recoveredAt, key, runId, previousOwnerToken, recoveredAt).run()
    if ((result.meta.changes ?? 0) > 0) return { claimed: true, recovered: true, owner_run_id: runId, owner_token: ownerToken, state: 'claimed', lease_expires_at: leaseExpiresAt }
    return this.idempotencyClaim(key)
  }
  private async idempotencyClaim(key: string): Promise<IdempotencyClaim> {
    const row = await this.db.prepare('SELECT * FROM idempotency_claims WHERE idempotency_key=?').bind(key).first<Row>()
    if (!row) return { claimed: false, owner_run_id: '', state: 'claimed' }
    return { claimed: false, owner_run_id: text(row.run_id), owner_token: optionalText(row.owner_token), state: text(row.state) as 'claimed' | 'completed',
      lease_expires_at: optionalText(row.lease_expires_at), result: parse(row.result_json) }
  }
  async getIdempotentResult(key: string): Promise<DeliveryResult | undefined> {
    const row = await this.db.prepare("SELECT result_json FROM idempotency_claims WHERE idempotency_key=? AND state='completed'").bind(key).first<Row>()
    return row ? parse(row.result_json) : undefined
  }
  async saveIdempotentResult(key: string, result: DeliveryResult, ownerToken?: string): Promise<void> {
    const sql = `UPDATE idempotency_claims SET state='completed',result_json=?,completed_at=?,lease_expires_at=NULL
      WHERE idempotency_key=? AND run_id=?${ownerToken ? ' AND owner_token=?' : ''}`
    const values: unknown[] = [json(redact(result)), new Date().toISOString(), key, result.run_id]
    if (ownerToken) values.push(ownerToken)
    const updated = await this.db.prepare(sql).bind(...values).run()
    if ((updated.meta.changes ?? 0) === 0) throw new Error(`Idempotency claim is not owned by run ${result.run_id}.`)
  }

  async createApproval(approval: ApprovalRecord): Promise<ApprovalRecord> {
    const safe = { ...redact(approval), approver: redactFreeText(approval.approver), reason: redactFreeText(approval.reason) }
    await this.db.prepare(`INSERT OR IGNORE INTO approvals
      (approval_id,run_id,step_id,requested_action,risk_level,status,requested_at,decided_at,approver,reason,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(safe.approval_id, safe.run_id, safe.step_id, safe.requested_action, safe.risk_level, safe.status,
        safe.requested_at, safe.decided_at ?? null, safe.approver ?? null, safe.reason ?? null, safe.expires_at ?? null).run()
    return (await this.getApproval(approval.run_id, approval.step_id))!
  }
  async getApproval(runId: string, stepId?: string): Promise<ApprovalRecord | undefined> {
    const row = stepId
      ? await this.db.prepare('SELECT * FROM approvals WHERE run_id=? AND step_id=?').bind(runId, stepId).first<Row>()
      : await this.db.prepare('SELECT * FROM approvals WHERE run_id=? ORDER BY requested_at LIMIT 1').bind(runId).first<Row>()
    return row ? this.approvalFrom(row) : undefined
  }
  async decideApproval(approvalId: string, status: 'approved' | 'rejected', actor: string, decidedAt: string, reason?: string): Promise<ApprovalRecord | undefined> {
    const updated = await this.db.prepare(`UPDATE approvals SET status=?,approver=?,decided_at=?,reason=? WHERE approval_id=? AND status='pending'`)
      .bind(status, redactFreeText(actor), decidedAt, redactFreeText(reason) ?? null, approvalId).run()
    const row = await this.db.prepare('SELECT * FROM approvals WHERE approval_id=?').bind(approvalId).first<Row>()
    if (!row) return undefined
    const approval = this.approvalFrom(row)
    if ((updated.meta.changes ?? 0) === 0 && approval.status !== status) throw new Error(`Approval ${approvalId} already has decision ${approval.status}.`)
    return approval
  }

  async requestCancellation(runId: string, actor: string, requestedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE runs SET cancellation_requested_at=COALESCE(cancellation_requested_at,?),
      cancellation_requested_by=COALESCE(cancellation_requested_by,?),updated_at=?
      WHERE run_id=? AND status NOT IN ('completed','failed','cancelled','blocked','expired')`)
      .bind(requestedAt, redactFreeText(actor), requestedAt, runId).run()
    return (result.meta.changes ?? 0) > 0
  }
  async isCancellationRequested(runId: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT cancellation_requested_at FROM runs WHERE run_id=?').bind(runId).first<Row>()
    return Boolean(row?.cancellation_requested_at)
  }
  async listRecoverableRuns(): Promise<Run[]> {
    const rows = await this.db.prepare("SELECT * FROM runs WHERE status IN ('queued','validating','planning','awaiting_approval','executing','verifying') ORDER BY started_at").all<Row>()
    return rows.results.map((row) => this.runFrom(row))
  }
  async appendRecoveryAttempt(attempt: RecoveryAttempt): Promise<void> {
    await this.db.prepare(`INSERT INTO recovery_attempts (recovery_id,run_id,started_at,completed_at,classification,outcome,actor) VALUES (?,?,?,?,?,?,?)`)
      .bind(attempt.recovery_id, attempt.run_id, attempt.started_at, attempt.completed_at ?? null, attempt.classification, attempt.outcome ?? null, attempt.actor).run()
  }
  async completeRecoveryAttempt(recoveryId: string, completedAt: string, outcome: RecoveryOutcome): Promise<void> {
    await this.db.prepare('UPDATE recovery_attempts SET completed_at=?,outcome=? WHERE recovery_id=?').bind(completedAt, outcome, recoveryId).run()
  }

  private approvalFrom(row: Row): ApprovalRecord {
    return { approval_id: text(row.approval_id), run_id: text(row.run_id), step_id: text(row.step_id), requested_action: text(row.requested_action),
      risk_level: Number(row.risk_level) as ApprovalRecord['risk_level'], status: text(row.status) as ApprovalRecord['status'], requested_at: text(row.requested_at),
      decided_at: optionalText(row.decided_at), approver: optionalText(row.approver), reason: optionalText(row.reason), expires_at: optionalText(row.expires_at) }
  }
  private runFrom(row: Row): Run {
    return { run_id: text(row.run_id), task_id: row.task_id === null ? 'unresolved' : text(row.task_id), status: text(row.status) as Run['status'],
      started_at: text(row.started_at), finished_at: optionalText(row.finished_at), attempt: Number(row.attempt), policy_decision: parse(row.policy_decision_json),
      result: parse(row.result_json), error: parse(row.error_json), cancellation_requested_at: optionalText(row.cancellation_requested_at),
      cancellation_requested_by: optionalText(row.cancellation_requested_by), recovery_outcome: optionalText(row.recovery_outcome) as RecoveryOutcome | undefined }
  }
  private stepFrom(row: Row): Step {
    return { step_id: text(row.step_id), run_id: text(row.run_id), sequence: Number(row.sequence), tool: text(row.tool), action: text(row.action),
      input: parse(row.input_json) ?? {}, expected_outcome: parse(row.expected_outcome_json), risk_level: Number(row.risk_level) as Step['risk_level'],
      status: text(row.status) as Step['status'], attempt: Number(row.attempt), idempotency_key: text(row.idempotency_key), started_at: optionalText(row.started_at),
      finished_at: optionalText(row.finished_at), duration_ms: row.duration_ms === null ? undefined : Number(row.duration_ms), output: parse(row.output_json),
      error: parse(row.error_json), verification_status: text(row.verification_status) as Step['verification_status'], policy_decision: parse(row.policy_decision_json),
      recovery_outcome: optionalText(row.recovery_outcome) as RecoveryOutcome | undefined }
  }
}
