# Runner OS — Master Blueprint

**Version:** 0.1
**Status:** Foundation / MVP definition
**Repository:** `Sparkmind-obp-off/Runner-os`

## 1. Purpose

Runner OS is a reliable execution runtime for AI-driven business operations.

The upstream system may discover demand, evaluate opportunities, and decide what should be done. Runner OS takes the resulting task and makes it happen through controlled tools and integrations.

The fundamental contract is:

> **Do not decide what is valuable. Execute the selected task reliably, verify what happened, preserve evidence, and report the outcome.**

## 2. System Boundary

```text
┌───────────────────────────────┐
│ Intelligence / Opportunity    │
│ Layer                         │
│ demand → opportunity → score  │
└───────────────┬───────────────┘
                │ validated task
                ▼
┌───────────────────────────────┐
│           RUNNER OS            │
│                               │
│  Task Intake                  │
│      ↓                        │
│  Policy / Risk Gate            │
│      ↓                        │
│  Planner                       │
│      ↓                        │
│  Executor                     │
│      ↓                        │
│  Tool / Connector Adapters    │
│      ↓                        │
│  Verification                 │
│      ↓                        │
│  Evidence + Audit             │
│      ↓                        │
│  Result / Delivery            │
└───────────────────────────────┘
```

Runner OS should remain useful even if the upstream intelligence layer is replaced.

## 3. MVP Execution Contract

Every run has a stable identity and lifecycle:

```text
CREATED
  → VALIDATING
  → PLANNING
  → RUNNING
  → VERIFYING
  → COMPLETED
```

Failure states:

```text
VALIDATING → FAILED
PLANNING   → FAILED
RUNNING    → FAILED / PAUSED
VERIFYING  → FAILED
```

A run must never be reported as successful merely because a tool call returned HTTP 200 or an SDK returned without throwing. Success means the configured verification condition passed.

## 4. Core Objects

### Task

Represents requested work.

Minimum fields:

- `task_id`
- `task_type`
- `objective`
- `input`
- `constraints`
- `risk_level`
- `requested_by`
- `created_at`

### Run

Represents one execution attempt for a task.

Minimum fields:

- `run_id`
- `task_id`
- `status`
- `started_at`
- `finished_at`
- `attempt`
- `result`
- `error`

### Step

Represents one atomic execution unit.

Minimum fields:

- `step_id`
- `run_id`
- `sequence`
- `action`
- `tool`
- `input_summary`
- `output_summary`
- `status`
- `duration_ms`
- `verification`

### Evidence

Represents proof that an action or result occurred.

Examples:

- API response metadata
- created record ID
- URL
- returned object hash
- verification result
- screenshot/reference when applicable

Sensitive payloads must not be copied into logs unnecessarily.

## 5. Tool Adapter Contract

Runner OS should interact with external systems through adapters rather than embedding provider-specific logic throughout the runtime.

Conceptually:

```text
ToolAdapter
├── name
├── version
├── capabilities
├── validate(input)
├── execute(input, context)
└── verify(output, expected)
```

The first adapters should be deliberately small and safe. Examples include read/search operations and controlled record creation in a test environment.

## 6. Policy and Risk Gates

Actions are classified before execution.

### Level 0 — Read-only

Examples: search, fetch, inspect, calculate.

Can run automatically.

### Level 1 — Internal mutation

Examples: create/update an internal database record.

Can run automatically when the task policy allows it.

### Level 2 — External communication

Examples: sending an email, publishing content, contacting a lead.

Requires explicit policy authorization and should support human approval.

### Level 3 — High-impact/destructive

Examples: financial transactions, deletion of important records, irreversible external actions.

Default: blocked until explicit human authorization exists.

## 7. Idempotency

Retries are expected. Therefore each mutation-capable step should accept an idempotency key when the target system supports it.

Recommended key:

```text
<run_id>:<step_id>:<attempt-safe-operation-id>
```

If a provider does not support idempotency, Runner OS must use a verification-before-retry strategy where practical.

## 8. Verification

Verification is a first-class stage, not an afterthought.

A step should define:

```text
expected outcome
      ↓
execute action
      ↓
observe returned state
      ↓
compare with expected outcome
      ↓
PASS / FAIL / UNKNOWN
```

`UNKNOWN` must not be silently converted to `PASS`.

## 9. Observability

Each run should produce structured events sufficient to answer:

- What task was requested?
- Why was the run allowed?
- Which tools were used?
- What inputs were sent?
- What happened at each step?
- What was verified?
- What failed?
- What evidence supports the final result?
- How long did execution take?

Secrets, access tokens, passwords, and unnecessary personal data must never be written to logs.

## 10. Failure Handling

Runner OS distinguishes:

- **Retryable:** timeout, transient provider error, rate limit.
- **Recoverable:** missing data or temporary dependency state where another strategy can work.
- **Non-retryable:** invalid input, denied policy, authentication configuration error.
- **Unknown:** execution outcome cannot be reliably determined.

Unknown mutation outcomes require verification before another mutation attempt.

## 11. Delivery Contract

The final response from Runner OS should be machine-readable internally and human-readable externally.

Minimum result shape:

```text
status
run_id
summary
outputs[]
evidence[]
warnings[]
errors[]
next_action
```

A successful result should state what actually happened, not what the agent intended to happen.

## 12. Security Baseline

- Secrets come from environment/secret management, never source control.
- Tool permissions follow least privilege.
- External actions are policy-gated.
- Audit records are append-oriented.
- Logs redact credentials and sensitive values.
- Every execution has a traceable run ID.
- Connector failures must not expose provider secrets to task outputs.

## 13. MVP Architecture

Recommended initial implementation:

```text
src/
├── core/
│   ├── task
│   ├── run
│   ├── step
│   └── result
├── engine/
│   ├── runner
│   ├── planner
│   ├── executor
│   └── verifier
├── policy/
│   └── risk-gate
├── adapters/
│   └── <tool-adapters>
├── observability/
│   ├── events
│   └── audit
└── config/
```

The exact language/framework is intentionally not hard-coded into this blueprint. The implementation should favor the smallest reliable stack that can run locally and deploy cleanly to the intended production environment.

## 14. First Vertical Slice

The first end-to-end implementation should prove exactly one complete safe workflow:

```text
create task
 → validate
 → plan one or more steps
 → execute a safe tool
 → verify result
 → persist audit event
 → return result
```

Do not build a large connector catalog before this vertical slice works.

## 15. Testing Gates

A build is not considered MVP-ready until it demonstrates:

1. successful execution;
2. validation failure;
3. tool failure;
4. retry of a transient failure;
5. verification failure;
6. idempotent/retry-safe mutation behavior;
7. policy denial for a restricted action;
8. complete audit trace;
9. secret redaction;
10. deterministic result formatting.

## 16. Roadmap

### Phase 0 — Contract

Freeze task/run/step/result contracts, policy model, adapter interface, and event model.

### Phase 1 — Runtime

Build the minimal Runner Engine and one safe adapter.

### Phase 2 — Reliability

Add retries, idempotency, verification, structured errors, and audit persistence.

### Phase 3 — Connectors

Add high-value integrations based on actual execution demand rather than connector count.

### Phase 4 — Operator Layer

Allow an upstream AI operator to translate validated objectives into Runner OS tasks while preserving policy boundaries.

### Phase 5 — Production Hardening

Add authentication, tenant isolation if needed, rate limits, monitoring, deployment automation, and operational runbooks.

## 17. Definition of Done

Runner OS MVP is done when a real task can enter the system, execute through a controlled adapter, prove its outcome, survive expected transient failures, produce an auditable trace, and return a trustworthy result without requiring the operator to manually inspect hidden internal state.

## 18. Strategic Rule

**Build the runner before building the autonomous operator.**

The operator can become smarter later. If the execution substrate is unreliable, more intelligence only makes failure happen faster and at larger scale.
