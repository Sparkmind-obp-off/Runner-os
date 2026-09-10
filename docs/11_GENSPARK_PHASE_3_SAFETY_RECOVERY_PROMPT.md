# Runner OS — Genspark Phase 3 Safety & Recovery Implementation Prompt

## Mission

Implement **Phase 3 — Safety & Recovery Hardening** for Runner OS in this repository.

Phase 0 and Phase 1 established the execution engine. Phase 2 added durable Cloudflare D1 persistence. Your job in this session is to make safety decisions and recovery behavior durable and restart-aware **without redesigning Runner OS** and without adding external providers or operator-facing features.

The target execution architecture remains:

`Task → Normalize → Validate → Plan → Policy Check → Approval Gate → Execute → Observe → Verify → Persist Evidence → Audit → Recover/Advance/Stop → Deliver Result`

The core objective is simple:

> A Runner OS run must not become unsafe, ambiguous, duplicated, or permanently stuck merely because a Worker/runtime instance restarted, an approval is pending, a provider outcome is unknown, or an execution attempt was interrupted.

## Source of Truth

Read these documents before changing implementation:

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
11. `docs/10_GENSPARK_PHASE_2_PERSISTENCE_PROMPT.md`

Then inspect the **actual current Phase 2 source code, migrations, tests, and README**. Treat the current implementation—not assumptions from these documents—as the starting point.

Current Phase 2 baseline commit:

`5d02ee9535257b9d0b02f810c1b542a894150293`

## Phase 3 Goal

Harden the durable runner against safety and recovery failures introduced by real runtime interruption and long-lived execution state.

The Phase 3 exit condition is:

> Approval, cancellation, idempotency ownership, interrupted execution, and unknown outcomes have explicit durable state and safe restart-aware behavior, with tests proving that recovery never creates an unverified duplicate side effect.

## Required Scope

### 1. Durable approval records and resume flow

Move approval state out of transient task input where necessary so an approval-required run can safely survive runtime restart.

Implement the smallest durable approval model needed by the existing domain:

- approval record/decision identity;
- run association;
- requested risk/action context;
- status such as `pending`, `approved`, `rejected`, `expired`;
- requested/decided timestamps;
- actor/approver reference without secrets;
- optional decision reason;
- stable linkage to the run/step requiring approval.

Required behavior:

- Level 2/3 actions remain blocked until policy approval is valid.
- Rejected/expired approvals never execute the protected action.
- An approved run can resume from durable state without rebuilding unsafe state from memory.
- Restart while awaiting approval must preserve the pending state.
- Duplicate approval submissions must be idempotent and must not produce duplicate side effects.
- Approval decisions must be represented in audit events.
- Approval data must not contain credentials or unnecessary sensitive data.

Do not build a UI for approval. Expose only the minimal internal/API contract needed by current architecture and tests.

### 2. Durable idempotency claim lifecycle and leases

Phase 2 introduced durable idempotency claims. Harden them for interrupted execution.

Implement explicit claim lifecycle semantics sufficient to distinguish:

- `claimed/running`;
- `completed`;
- safely recoverable/expired ownership.

Add a lease/heartbeat/expiry mechanism only as far as necessary for safe recovery.

Requirements:

- A live claim cannot be stolen while its lease is valid.
- An abandoned claim can become recoverable after a deterministic expiry condition.
- Recovery must not automatically re-execute an operation whose external side effect may already have happened unless the adapter verification contract proves it is safe.
- Completed idempotency results remain replayable.
- Duplicate requests remain side-effect-free.
- Claim ownership and recovery decisions are auditable.
- Concurrency guarantees remain scoped accurately to the configured D1 database.

Prefer database constraints/atomic updates over application-only race prevention.

### 3. Restart-aware run recovery

Implement a deterministic recovery mechanism for runs left in non-terminal states after runtime interruption.

At minimum handle durable runs found in states such as:

- `queued`;
- `validating`;
- `planning`;
- `awaiting_approval`;
- `executing`;
- `verifying`.

Recovery must classify each state rather than blindly rerunning it.

Rules:

- `awaiting_approval` resumes as pending approval unless a valid durable decision already exists.
- Work that was never side-effecting may safely resume/replan according to current state-machine rules.
- An interrupted side-effecting step must be treated as potentially having executed.
- An interrupted/unknown side-effecting step must verify before any retry/recovery decision.
- Never convert an unknown outcome directly into a fresh execution.
- Terminal runs remain terminal and are never resurrected.
- Recovery itself is audited.
- Recovery must be idempotent: running recovery repeatedly must not duplicate work.

Use explicit state transitions and recovery classifications. Do not hide recovery inside generic retry logic.

### 4. Cancellation semantics across restart

Harden cancellation so cancellation intent survives runtime restart.

Required behavior:

- cancellation is durable;
- no new side-effecting step begins after cancellation is observed;
- an in-flight external operation may still complete outside Runner OS control;
- therefore cancellation of an in-flight side-effecting operation does not falsely claim that the provider side effect was undone;
- when provider continuation is possible, verification is required before finalizing the run;
- repeated cancellation requests are idempotent;
- cancellation decisions are auditable.

Do not implement provider-specific cancellation APIs in this phase.

### 5. Unknown-outcome recovery contract

Strengthen the existing verification-first behavior for timeouts/interrupted mutations.

Define a clear internal classification such as:

`KNOWN_SUCCESS | KNOWN_FAILURE | UNKNOWN_REQUIRES_VERIFICATION | RECOVERY_BLOCKED`

or an equivalent model that fits the existing code.

For an unknown mutation outcome:

1. persist the unknown state/evidence;
2. attempt verification using the existing adapter contract;
3. if verification proves success, persist success and do not execute again;
4. if verification proves the operation did not happen, recovery may retry only when policy + idempotency rules permit;
5. if verification remains inconclusive, stop safely in an explicit recoverable/blocked state rather than guessing.

Do not weaken verification to make tests pass.

### 6. Safety audit trail

Extend the existing append-oriented audit trail to cover safety/recovery decisions, including where applicable:

- approval requested;
- approval approved/rejected/expired;
- cancellation requested/observed;
- claim acquired/renewed/recovered;
- run recovery started/completed/blocked;
- unknown outcome classified;
- verification attempted/result;
- recovery retry allowed/denied;
- recovery blocked because outcome remains ambiguous.

Audit records must be redacted and must not contain raw secrets.

### 7. State-machine hardening

Review the current run and step state machines against restart/recovery scenarios.

Add explicit legal transitions needed for Phase 3, but do not loosen existing safety invariants.

At minimum enforce:

- terminal → no execution;
- blocked → no execution without a new explicitly valid run/approval path;
- cancelled → no new side effects;
- expired approval → protected action remains blocked;
- unknown side effect → verification before retry;
- completed idempotency key → no duplicate execution.

If a new status is required, document why it exists and keep the domain vocabulary small.

### 8. Persistence changes and migration

Extend the existing D1 schema with the minimum new columns/tables/indexes required for Phase 3.

Provide a new reproducible migration, for example:

`migrations/0002_safety_recovery.sql`

Do not rewrite or destructively replace the Phase 2 migration.

Migration requirements:

- fresh database setup remains reproducible;
- upgrade from the Phase 2 schema is supported;
- indexes cover recovery/lease/approval lookups;
- constraints protect valid status combinations where practical;
- timestamps are explicit and deterministic;
- no secrets are stored.

### 9. API compatibility

Preserve existing endpoints:

- `GET /`
- `GET /health`
- `POST /api/runs`
- `GET /api/runs/:runId`

If the current architecture requires a minimal endpoint for approval/cancel/recovery operations, add only the smallest explicit API surface and document it. Do not build a dashboard or UI.

Do not add:

- external GitHub/Make/HTTP adapters;
- AI Business Operator integration;
- voice;
- queues;
- scheduler;
- webhook orchestration;
- parallel execution;
- billing;
- analytics platform;
- multi-tenant product features.

### 10. Documentation

Update `README.md` and/or add one focused Phase 3 document to accurately describe:

- Phase 3 status;
- approval persistence/resume behavior;
- idempotency claim/lease behavior;
- restart recovery rules;
- cancellation semantics;
- unknown-outcome handling;
- safety/audit guarantees;
- migration/setup commands;
- known limitations;
- exact next recommended phase.

Do not rewrite the entire architecture documentation.

## Architecture Rules

- Do not redesign Runner OS.
- Do not introduce provider-specific safety logic into the core.
- Do not bypass `RunnerStore`.
- Do not weaken policy, verification, idempotency, or audit requirements.
- Do not assume a Worker process remains alive after an external call begins.
- Do not assume timeout means failure or success.
- Do not blindly replay an interrupted side effect.
- Do not let tool output redefine policy.
- Do not commit secrets, credentials, tokens, `.env`, or `.dev.vars`.
- Keep the implementation Cloudflare/D1 compatible.
- Prefer explicit state transitions, small modules, SQL constraints, and deterministic recovery over heavy frameworks.
- Preserve existing Phase 1 and Phase 2 behavior unless a change is strictly required for a documented Phase 3 safety invariant.
- Do not start Phase 4.

## Safety Invariants

Phase 3 must preserve and test these invariants:

1. **No duplicate side effect from replay** — the same stable idempotency key cannot cause duplicate Runner OS execution.
2. **Unknown is not failure** — an ambiguous provider result is never treated as permission to blindly retry.
3. **Verification precedes recovery** — an interrupted side-effecting operation is verified before deciding whether another execution is safe.
4. **Approval is durable** — a restart cannot erase an approval requirement or accidentally bypass it.
5. **Cancellation is durable** — a restart cannot erase cancellation intent.
6. **Terminal means terminal** — completed, failed, cancelled, blocked, and expired runs cannot silently return to execution.
7. **Recovery is idempotent** — running recovery multiple times produces no duplicate side effects.
8. **Audit is append-oriented** — safety decisions are recorded without overwriting history.
9. **Secrets stay out of persistence** — approval, recovery, evidence, and audit records are redacted.
10. **Provider-independent core** — no Phase 3 behavior depends on GitHub, Make, HTTP, or another external provider.

## Testing Requirements

Preserve all Phase 1 and Phase 2 tests.

Add deterministic tests for at least:

### Approval

- Level 2/3 run enters durable approval state.
- Pending approval survives fresh store/runtime instance.
- Approved durable run resumes safely.
- Rejected approval never executes the protected adapter.
- Expired approval never executes the protected adapter.
- Duplicate approval decision is idempotent.
- Approval events appear in audit history.

### Idempotency / leases

- First request acquires claim.
- Concurrent duplicate cannot acquire the same live claim.
- Completed claim returns the original result.
- Live lease cannot be stolen.
- Expired/abandoned claim can be recovered.
- Recovery does not blindly execute an ambiguous side effect.
- Repeated recovery is idempotent.

### Restart recovery

- Interrupted `awaiting_approval` resumes as pending/approved/rejected according to durable state.
- Interrupted non-side-effecting work resumes safely.
- Interrupted side-effecting work becomes unknown and requires verification.
- Verification proves success → no duplicate execution.
- Verification proves no side effect → retry only when allowed.
- Verification remains inconclusive → explicit blocked/recoverable state; no blind retry.
- Terminal runs are ignored by recovery.

### Cancellation

- Cancellation survives restart.
- Cancellation before execution prevents side effects.
- Cancellation during/after an uncertain mutation does not falsely report rollback.
- Repeated cancellation is idempotent.
- Cancellation and recovery decisions are audited.

### Security / regression

- Existing policy denial still prevents adapter execution.
- Tool output cannot change approval/policy decisions.
- No secrets appear in persisted task/run/step/evidence/audit/approval/recovery records.
- Existing Phase 1 mandatory scenarios remain green.
- Existing Phase 2 persistence/re-instantiation scenarios remain green.

Use the project's existing test conventions and local D1 harness. Do not require a real Cloudflare production account or production credentials for tests.

## Required Commands

At minimum run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

Also run the appropriate local D1 migration/setup tests, including proving:

1. Phase 2 schema can be upgraded with the new migration;
2. a fresh database can apply all migrations in order;
3. Phase 3 recovery data survives store/runtime re-instantiation.

If any command cannot run because of an environment prerequisite, report the exact blocker. Never fake success.

## Definition of Done — Phase 3

Phase 3 is complete only when:

1. durable approval/resume state exists where required;
2. durable idempotency claims support safe interrupted-run recovery;
3. lease/expiry behavior is deterministic and tested;
4. restart recovery is explicit and safe;
5. unknown side-effect outcomes require verification before recovery/retry;
6. cancellation semantics survive restart;
7. safety/recovery decisions are audited;
8. all Phase 1 and Phase 2 tests remain green;
9. Phase 3-specific tests pass;
10. migrations are reproducible;
11. typecheck/build/check pass;
12. no secrets are committed;
13. README/docs accurately describe guarantees and limitations;
14. the exact next phase is identified.

## Explicit Non-Goals

Do **NOT** implement in this session:

- real GitHub adapter;
- real Make adapter;
- real HTTP/external provider integration;
- AI Business Operator integration;
- autonomous AI planning;
- dashboard/UI;
- voice interface;
- queues;
- scheduler;
- webhook orchestration;
- parallel execution;
- multi-tenant authorization;
- billing;
- analytics platform;
- speculative abstractions unrelated to safety/recovery.

Those belong to later phases.

## Final Output

After implementation, report concisely:

- files created/changed;
- Phase 3 state/recovery model;
- approval persistence/resume behavior;
- idempotency lease/recovery behavior;
- cancellation semantics;
- unknown-outcome handling;
- migration(s) added;
- commands executed;
- complete test results;
- local/Cloudflare setup requirements;
- known limitations;
- exact recommended next phase.

Then stop.

**Do not start Phase 4 or add unrelated features.**
