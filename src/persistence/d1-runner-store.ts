import { stableStringify } from '../core/hash'
import { redact } from '../security/redaction'
import type { AuditEvent, DeliveryResult, Evidence, Run, Step, Task } from '../core/types'
import type { IdempotencyClaim, RunnerStore } from './store'

type Row = Record<string, unknown>
const json = (value: unknown): string => stableStringify(value)
const nullableJson = (value: unknown): string | null => value === undefined ? null : json(value)
const parse = <T>(value: unknown): T | undefined => typeof value === 'string' && value.length > 0 ? JSON.parse(value) as T : undefined
const text = (value: unknown): string => String(value)

export class D1RunnerStore implements RunnerStore {
  constructor(private readonly db: D1Database) {}

  async saveTask(task: Task): Promise<void> {
    const safe = redact(task)
    await this.db.prepare(`INSERT INTO tasks (
      task_id,idempotency_key,type,objective,input_json,constraints_json,risk_level,requested_at,requested_by,policy_context_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET
      type=excluded.type, objective=excluded.objective, input_json=excluded.input_json,
      constraints_json=excluded.constraints_json, risk_level=excluded.risk_level,
      requested_at=excluded.requested_at, requested_by=excluded.requested_by,
      policy_context_json=excluded.policy_context_json
    `).bind(safe.task_id, safe.idempotency_key, safe.type, safe.objective, json(safe.input), json(safe.constraints), safe.risk_level,
      safe.requested_at, safe.requested_by, json(safe.policy_context)).run()
  }

  async saveRun(run: Run): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO runs (
      run_id,task_id,status,started_at,finished_at,attempt,policy_decision_json,result_json,error_json,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      task_id=excluded.task_id,status=excluded.status,started_at=excluded.started_at,finished_at=excluded.finished_at,
      attempt=excluded.attempt,policy_decision_json=excluded.policy_decision_json,result_json=excluded.result_json,
      error_json=excluded.error_json,updated_at=excluded.updated_at
    WHERE runs.status NOT IN ('completed','failed','cancelled','blocked','expired') OR runs.status=excluded.status
    `).bind(run.run_id, run.task_id === 'unresolved' ? null : run.task_id, run.status, run.started_at, run.finished_at ?? null,
      run.attempt, nullableJson(run.policy_decision), nullableJson(run.result), nullableJson(run.error), new Date().toISOString()).run()
    if ((result.meta.changes ?? 0) === 0) throw new Error(`Rejected transition from terminal run ${run.run_id}.`)
  }

  async saveStep(step: Step): Promise<void> {
    const result = await this.db.prepare(`INSERT INTO steps (
      step_id,run_id,sequence,tool,action,input_json,expected_outcome_json,risk_level,status,attempt,idempotency_key,
      started_at,finished_at,duration_ms,output_json,error_json,verification_status,policy_decision_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(step_id) DO UPDATE SET
      sequence=excluded.sequence,tool=excluded.tool,action=excluded.action,input_json=excluded.input_json,
      expected_outcome_json=excluded.expected_outcome_json,risk_level=excluded.risk_level,status=excluded.status,
      attempt=excluded.attempt,started_at=excluded.started_at,finished_at=excluded.finished_at,
      duration_ms=excluded.duration_ms,output_json=excluded.output_json,error_json=excluded.error_json,
      verification_status=excluded.verification_status,policy_decision_json=excluded.policy_decision_json
    WHERE steps.status NOT IN ('succeeded','failed','blocked','skipped') OR steps.status=excluded.status
    `).bind(step.step_id, step.run_id, step.sequence, step.tool, step.action, json(redact(step.input)),
      nullableJson(redact(step.expected_outcome)), step.risk_level, step.status, step.attempt, step.idempotency_key,
      step.started_at ?? null, step.finished_at ?? null, step.duration_ms ?? null, nullableJson(redact(step.output)),
      nullableJson(redact(step.error)), step.verification_status, nullableJson(step.policy_decision)).run()
    if ((result.meta.changes ?? 0) === 0) throw new Error(`Rejected transition from terminal step ${step.step_id}.`)
  }

  async appendEvidence(evidence: Evidence): Promise<void> {
    await this.db.prepare(`INSERT INTO evidence
      (evidence_id,run_id,step_id,type,source,payload_reference_json,captured_at,integrity_hash)
      VALUES (?,?,?,?,?,?,?,?)`).bind(evidence.evidence_id, evidence.run_id, evidence.step_id, evidence.type, evidence.source,
      json(redact(evidence.payload_reference)), evidence.captured_at, evidence.integrity_hash).run()
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await this.db.prepare(`INSERT INTO audit_events
      (event_id,run_id,timestamp,event_type,actor,metadata_json) VALUES (?,?,?,?,?,?)`)
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
    return rows.results.map((row) => ({
      evidence_id: text(row.evidence_id), run_id: text(row.run_id), step_id: text(row.step_id),
      type: text(row.type) as Evidence['type'], source: text(row.source),
      payload_reference: parse<Record<string, unknown>>(row.payload_reference_json) ?? {},
      captured_at: text(row.captured_at), integrity_hash: text(row.integrity_hash),
    }))
  }

  async getAudit(runId: string): Promise<AuditEvent[]> {
    const rows = await this.db.prepare('SELECT * FROM audit_events WHERE run_id=? ORDER BY timestamp,event_id').bind(runId).all<Row>()
    return rows.results.map((row) => ({
      event_id: text(row.event_id), run_id: text(row.run_id), timestamp: text(row.timestamp),
      event_type: text(row.event_type), actor: text(row.actor), metadata: parse<Record<string, unknown>>(row.metadata_json) ?? {},
    }))
  }

  async claimIdempotency(key: string, runId: string, claimedAt: string): Promise<IdempotencyClaim> {
    const inserted = await this.db.prepare(`INSERT OR IGNORE INTO idempotency_claims
      (idempotency_key,run_id,state,result_json,claimed_at) VALUES (?,?, 'claimed',NULL,?)`)
      .bind(key, runId, claimedAt).run()
    if ((inserted.meta.changes ?? 0) > 0) return { claimed: true }
    return { claimed: false, result: await this.getIdempotentResult(key) }
  }

  async getIdempotentResult(key: string): Promise<DeliveryResult | undefined> {
    const row = await this.db.prepare('SELECT result_json FROM idempotency_claims WHERE idempotency_key=? AND state=\'completed\'')
      .bind(key).first<Row>()
    return row ? parse<DeliveryResult>(row.result_json) : undefined
  }

  async saveIdempotentResult(key: string, result: DeliveryResult): Promise<void> {
    const updated = await this.db.prepare(`UPDATE idempotency_claims SET state='completed',result_json=?,completed_at=?
      WHERE idempotency_key=? AND run_id=?`).bind(json(redact(result)), new Date().toISOString(), key, result.run_id).run()
    if ((updated.meta.changes ?? 0) === 0) throw new Error(`Idempotency claim is not owned by run ${result.run_id}.`)
  }

  private runFrom(row: Row): Run {
    return {
      run_id: text(row.run_id), task_id: row.task_id === null ? 'unresolved' : text(row.task_id), status: text(row.status) as Run['status'],
      started_at: text(row.started_at), finished_at: row.finished_at === null ? undefined : text(row.finished_at), attempt: Number(row.attempt),
      policy_decision: parse(row.policy_decision_json), result: parse(row.result_json), error: parse(row.error_json),
    }
  }

  private stepFrom(row: Row): Step {
    return {
      step_id: text(row.step_id), run_id: text(row.run_id), sequence: Number(row.sequence), tool: text(row.tool), action: text(row.action),
      input: parse<Record<string, unknown>>(row.input_json) ?? {}, expected_outcome: parse(row.expected_outcome_json), risk_level: Number(row.risk_level) as Step['risk_level'],
      status: text(row.status) as Step['status'], attempt: Number(row.attempt), idempotency_key: text(row.idempotency_key),
      started_at: row.started_at === null ? undefined : text(row.started_at), finished_at: row.finished_at === null ? undefined : text(row.finished_at),
      duration_ms: row.duration_ms === null ? undefined : Number(row.duration_ms), output: parse(row.output_json), error: parse(row.error_json),
      verification_status: text(row.verification_status) as Step['verification_status'], policy_decision: parse(row.policy_decision_json),
    }
  }
}
