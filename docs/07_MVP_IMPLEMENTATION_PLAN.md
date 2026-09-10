# Runner OS — MVP Implementation Plan

## Phase 0 — Contract First

Deliver:
- task schema
- run schema
- step schema
- evidence schema
- adapter interface
- policy interface
- result/error contract

Exit gate: contracts are documented and covered by schema tests.

## Phase 1 — In-Memory Runner

Build a local sequential engine using the mock adapter.

Scenario:

`Task → Run → Step → Mock Execute → Verify → Evidence → Result`

Exit gate: happy path and controlled failure paths pass.

## Phase 2 — Persistence

Add a replaceable repository interface and first persistence implementation.

Persist:
- tasks
- runs
- steps
- evidence
- audit events

Exit gate: process restart does not destroy completed-run evidence.

## Phase 3 — Safety & Recovery

Add:
- policy evaluator
- approval gate
- idempotency registry
- retry budget
- unknown-outcome recovery
- cancellation semantics

Exit gate: duplicate and unsafe actions are prevented in tests.

## Phase 4 — Real Adapter

Implement one useful external adapter behind the contract. Prefer a low-risk operation with independently verifiable output.

Exit gate: real integration passes contract, verification, audit, and failure tests.

## Phase 5 — Operator Integration

Expose Runner OS to an upstream operator through a stable API.

The operator submits intent/task definitions. Runner OS owns execution state and evidence.

Exit gate: operator can submit a task and receive a verified delivery result without depending on provider-specific implementation details.

## Suggested Project Layout

```text
src/
  core/
    task/
    run/
    step/
    engine/
    policy/
    retry/
    idempotency/
  adapters/
  verification/
  evidence/
  audit/
  persistence/
  api/
  config/
tests/
  unit/
  integration/
  contract/
  e2e/
docs/
```

## Build Rule

Do not start with dashboards, voice UI, or dozens of integrations.

First prove that one task can be executed, verified, evidenced, and delivered reliably.
