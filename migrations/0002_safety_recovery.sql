PRAGMA foreign_keys = ON;

ALTER TABLE runs ADD COLUMN cancellation_requested_at TEXT;
ALTER TABLE runs ADD COLUMN cancellation_requested_by TEXT;
ALTER TABLE runs ADD COLUMN recovery_outcome TEXT CHECK (recovery_outcome IS NULL OR recovery_outcome IN ('KNOWN_SUCCESS','KNOWN_FAILURE','UNKNOWN_REQUIRES_VERIFICATION','RECOVERY_BLOCKED'));

ALTER TABLE steps ADD COLUMN recovery_outcome TEXT CHECK (recovery_outcome IS NULL OR recovery_outcome IN ('KNOWN_SUCCESS','KNOWN_FAILURE','UNKNOWN_REQUIRES_VERIFICATION','RECOVERY_BLOCKED'));

ALTER TABLE idempotency_claims ADD COLUMN owner_token TEXT;
ALTER TABLE idempotency_claims ADD COLUMN lease_expires_at TEXT;
ALTER TABLE idempotency_claims ADD COLUMN heartbeat_at TEXT;
ALTER TABLE idempotency_claims ADD COLUMN recovered_at TEXT;

UPDATE idempotency_claims
SET owner_token = run_id,
    heartbeat_at = claimed_at,
    lease_expires_at = claimed_at
WHERE owner_token IS NULL;

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES steps(step_id) ON DELETE CASCADE,
  requested_action TEXT NOT NULL,
  risk_level INTEGER NOT NULL CHECK (risk_level BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  approver TEXT,
  reason TEXT,
  expires_at TEXT,
  CHECK (
    (status = 'pending' AND decided_at IS NULL)
    OR (status IN ('approved','rejected','expired') AND decided_at IS NOT NULL)
  ),
  UNIQUE (run_id, step_id)
);

CREATE TABLE recovery_attempts (
  recovery_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  classification TEXT NOT NULL CHECK (classification IN ('SAFE_RESUME','AWAITING_APPROVAL','VERIFY_REQUIRED','TERMINAL_IGNORED','RECOVERY_BLOCKED')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('KNOWN_SUCCESS','KNOWN_FAILURE','UNKNOWN_REQUIRES_VERIFICATION','RECOVERY_BLOCKED')),
  actor TEXT NOT NULL
);

CREATE INDEX idx_approvals_run_status ON approvals(run_id, status);
CREATE INDEX idx_approvals_step ON approvals(step_id);
CREATE INDEX idx_claims_state_lease ON idempotency_claims(state, lease_expires_at);
CREATE INDEX idx_runs_recovery_status ON runs(status, recovery_outcome, started_at);
CREATE INDEX idx_recovery_run_started ON recovery_attempts(run_id, started_at);
