# Runner OS — Genspark Phase 2 Persistence Implementation Prompt

## Mission

Implement **Phase 2 — Durable Persistence** for Runner OS in this repository.

Phase 0 and Phase 1 are already complete. The current system is a provider-independent execution engine using in-memory repositories. Your job is to add durable Cloudflare D1 persistence **without redesigning the Runner OS architecture**.

The target architecture remains:

`Task → Normalize → Validate → Plan → Policy Check → Execute → Observe → Verify → Persist Evidence → Audit → Deliver Result`

Persistence must sit behind the existing repository/store interfaces so the execution engine remains provider-agnostic and testable.

## Source of Truth

Read and follow these documents before changing implementation:

1. `README.md`
2. `docs/01_RUNNER_OS_MASTER_BLUEPRINT.md`
3. `docs/02_PRODUCT_REQUIREMENTS.md`
4. `docs/03_DOMAIN_MODEL.md`
5. `docs/04_TOOL_ADAPTER_CONTRACT.md`
6. `docs/05_POLICY_SECURITY_MODEL.md`
7. `docs/06_EXECUTION_ENGINE_SPEC.md`
8. `docs/07_MVP_IMPLEMENTATION_PLAN.md`
9. `docs/08_TESTING_AND_ACCEPTANCE.md`
10. `docs/09_GENSPARK_IMPLEMENTATION_PROMPT.md`

Then inspect the **actual current Phase 1 source code** before implementing anything.

## Phase 2 Goal

Replace the Phase 1-only in-memory persistence implementation with a durable Cloudflare D1-backed implementation while preserving all existing contracts and behavior.

The Phase 2 exit condition is:

> A Runner OS run can be created, executed, verified, evidenced, audited, and retrieved from durable D1 storage across a fresh store/runtime instance, with existing Phase 1 behavior and tests preserved.

## Required Scope

Implement the following:

### 1. D1 database schema and migrations

Create a clear migration strategy for the entities required by the current domain model:

- tasks
- runs
- steps
- evidence
- audit_events
- idempotency records/claims

Use appropriate primary keys, foreign keys where compatible with the architecture, indexes for common lookups, timestamps, and status fields.

Do not create unnecessary tables or speculative business-domain tables.

### 2. D1RunnerStore

Implement a concrete `D1RunnerStore` behind the existing `RunnerStore` abstraction.

Requirements:

- preserve the existing domain interfaces;
- keep D1-specific SQL isolated inside the persistence layer;
- serialize/deserialize domain objects deterministically and safely;
- preserve IDs and timestamps;
- preserve run and step state transitions;
- preserve evidence and audit records;
- support retrieval by run ID;
- support the idempotency behavior required by the current engine;
- avoid leaking D1 implementation details into core execution logic.

If the current `RunnerStore` interface needs a minimal extension to support durable behavior, make the smallest backwards-compatible change and update the in-memory implementation accordingly.

### 3. Durable idempotency

Persist idempotency records/claims in D1.

The implementation must prevent duplicate execution for the same stable idempotency key within the supported D1 database scope.

Use database constraints/transactions where appropriate rather than relying only on application-level checks.

Clearly document the concurrency guarantees and their scope.

### 4. Evidence and audit durability

Evidence and audit events must survive runtime/store re-instantiation.

Maintain the existing append-oriented model.

Do not store secrets or raw credentials in evidence/audit data.

Preserve integrity hashes or equivalent evidence-integrity fields already implemented in Phase 1.

### 5. Restart/re-instantiation tests

Add automated tests proving that data written through one `D1RunnerStore` instance can be read by a fresh `D1RunnerStore` instance against the same D1 database.

At minimum prove persistence for:

- task/run metadata;
- steps and terminal state;
- execution evidence;
- verification evidence;
- audit events;
- idempotency records.

Use the project's existing test conventions. If a local D1 test harness is needed, choose the smallest production-sensible approach and document it.

Do not make the test suite dependent on a real production Cloudflare account or real production database credentials.

### 6. Configuration

Add the minimum required Cloudflare configuration for D1 binding and migrations.

Keep production secrets out of the repository.

If `wrangler.jsonc` already exists, extend it rather than replacing unrelated configuration.

Use a clearly named D1 binding such as `DB` only if that matches the existing project conventions; otherwise choose a consistent name and document it.

### 7. API compatibility

Keep existing endpoints working:

- `GET /`
- `GET /health`
- `POST /api/runs`
- `GET /api/runs/:runId`

Do not add a UI.

Do not add authentication, tenancy, queues, schedulers, webhooks, voice, or external providers in this phase.

### 8. Documentation

Update `README.md` to accurately state:

- Phase 2 status;
- D1 architecture;
- migration/setup commands;
- local development/test approach;
- required Cloudflare binding configuration;
- durable persistence guarantees;
- known limitations, especially any D1 concurrency or runtime constraints;
- the exact next recommended phase.

If useful, add a focused persistence document under `docs/`, but do not create documentation that duplicates the entire architecture.

## Architecture Rules

- Do not redesign Runner OS.
- Do not move provider-specific logic into persistence.
- Do not bypass `RunnerStore` from the execution engine.
- Do not weaken policy, verification, retry, or idempotency rules to simplify persistence.
- Do not remove existing Phase 1 tests.
- Do not replace deterministic behavior with AI behavior.
- Do not introduce unnecessary frameworks.
- Do not commit secrets, database credentials, API keys, or tokens.
- Keep the implementation Cloudflare-compatible.
- Prefer explicit SQL and small persistence modules over a heavy ORM unless the existing project already uses one.
- Preserve the existing public API contract unless a change is strictly required.

## Data Integrity Requirements

The persistence layer must preserve these invariants from the domain model:

1. terminal runs cannot transition back into execution;
2. blocked actions cannot execute;
3. side-effecting successful steps retain verification evidence according to current policy;
4. evidence and audit records are append-oriented;
5. stable idempotency keys remain stable across retries/restarts;
6. duplicate requests do not silently create duplicate side effects;
7. unknown mutation outcomes are verified before any retry decision;
8. secrets remain redacted from persisted audit/evidence payloads.

## Migration Requirements

Provide an explicit migration file or migration directory with a reproducible schema setup.

The migration process must be safe to run in a fresh local/test database and documented for Cloudflare D1 deployment.

Avoid destructive migrations unless absolutely required by the current Phase 1 schema—which is expected to be in-memory only.

## Testing Requirements

Run and preserve all existing mandatory scenarios from Phase 1, including:

- successful read-only task;
- successful low-risk write;
- validation failure;
- policy denial;
- approval approved/rejected if already implemented;
- retryable error;
- retry exhaustion;
- timeout/unknown outcome;
- verification failure;
- duplicate idempotency;
- cancellation behavior;
- adapter unavailable;
- untrusted tool output not changing policy.

Add Phase 2 persistence-specific coverage for:

- D1 schema initialization;
- CRUD/repository behavior;
- serialization round trips;
- restart/re-instantiation persistence;
- durable idempotency;
- evidence/audit persistence;
- retrieval of completed and failed runs;
- migration reproducibility.

Use deterministic test data.

## Required Commands

At minimum, run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

Also run the appropriate D1 migration/local database test command(s) and report exactly what was executed.

If a command cannot run because the environment lacks a Cloudflare/D1 prerequisite, do not fake success. Document the blocker and still complete every test that can run locally.

## Definition of Done — Phase 2

Phase 2 is complete only when:

1. D1 schema/migrations exist;
2. `D1RunnerStore` implements the existing persistence abstraction;
3. the execution engine can use D1 without provider-specific changes;
4. all existing Phase 1 tests still pass;
5. persistence/restart tests pass;
6. idempotency records are durable;
7. evidence and audit records are durable;
8. API behavior remains intact;
9. no secrets are committed;
10. README documents setup and limitations;
11. typecheck/build/check pass;
12. the exact next phase is identified.

## Explicit Non-Goals

Do **NOT** implement in this session:

- real GitHub/Make/HTTP external adapters;
- AI Business Operator integration;
- autonomous planning expansion;
- dashboard/UI;
- voice interface;
- queues;
- scheduler;
- webhook orchestration;
- parallel execution;
- multi-tenant authorization;
- billing;
- analytics platform;
- speculative abstractions unrelated to persistence.

Those belong to later phases.

## Final Output

After implementation, report concisely:

- files created/changed;
- D1 schema/tables and migration approach;
- how `D1RunnerStore` integrates with the existing `RunnerStore`;
- idempotency/concurrency guarantees;
- commands executed;
- complete test results;
- deployment/local setup requirements;
- known limitations;
- exact recommended next phase.

Then stop.

**Do not start Phase 3 or add unrelated features.**
