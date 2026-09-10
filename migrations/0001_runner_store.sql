PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  objective TEXT NOT NULL,
  input_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  risk_level INTEGER NOT NULL CHECK (risk_level BETWEEN 0 AND 3),
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  policy_context_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(task_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued','validating','planning','awaiting_approval','executing','verifying','completed','failed','cancelled','blocked','expired')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  policy_decision_json TEXT,
  result_json TEXT,
  error_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  input_json TEXT NOT NULL,
  expected_outcome_json TEXT,
  risk_level INTEGER NOT NULL CHECK (risk_level BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK (status IN ('pending','validating','executing','verifying','succeeded','retryable_failure','failed','blocked','skipped')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  output_json TEXT,
  error_json TEXT,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('PASS','FAIL','UNKNOWN')),
  policy_decision_json TEXT,
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('execution','verification')),
  source TEXT NOT NULL,
  payload_reference_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  integrity_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_claims (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('claimed','completed')),
  result_json TEXT,
  claimed_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((state = 'claimed' AND result_json IS NULL) OR (state = 'completed' AND result_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status_started_at ON runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_steps_run_sequence ON steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_evidence_run_captured ON evidence(run_id, captured_at, evidence_id);
CREATE INDEX IF NOT EXISTS idx_evidence_step ON evidence(step_id);
CREATE INDEX IF NOT EXISTS idx_audit_run_timestamp ON audit_events(run_id, timestamp, event_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_run ON idempotency_claims(run_id);
