# Runner OS — Domain Model

## Core Entities

### Task

The requested unit of work.

Required fields:
- `task_id`
- `type`
- `input`
- `requested_at`
- `requested_by`
- `policy_context`
- `idempotency_key`

### Run

A concrete execution instance of a task.

Required fields:
- `run_id`
- `task_id`
- `status`
- `started_at`
- `finished_at`
- `attempt`
- `policy_decision`
- `result`

### Step

A single executable unit inside a run.

Required fields:
- `step_id`
- `run_id`
- `sequence`
- `tool`
- `action`
- `input`
- `status`
- `attempt`
- `verification_status`

### Evidence

Machine-readable proof or supporting material produced during execution.

Fields:
- `evidence_id`
- `run_id`
- `step_id`
- `type`
- `source`
- `payload_reference`
- `captured_at`
- `integrity_hash` when applicable

### AuditEvent

Immutable record of an important state transition or decision.

Fields:
- `event_id`
- `run_id`
- `timestamp`
- `event_type`
- `actor`
- `metadata`

## Relationships

`Task 1 → N Run`

`Run 1 → N Step`

`Step 1 → N Evidence`

`Run 1 → N AuditEvent`

## State Model

### Run states

`queued → validating → planning → awaiting_approval → executing → verifying → completed`

Failure/terminal branches:

`failed`, `cancelled`, `blocked`, `expired`

### Step states

`pending → validating → executing → verifying → succeeded`

Failure branches:

`retryable_failure`, `failed`, `blocked`, `skipped`

## Invariants

- A run has exactly one task.
- A step belongs to exactly one run.
- A terminal run cannot execute new steps.
- A blocked action cannot execute until policy conditions change.
- A successful side-effecting step requires verification unless explicitly classified as non-verifiable by policy.
- Evidence is append-only.
- Audit events are append-only.
- Idempotency keys must be stable across retries of the same intended operation.
