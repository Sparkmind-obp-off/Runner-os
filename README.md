# Runner OS

Runner OS is the provider-independent execution layer for SparkMind's AI Business Operator direction. It receives an already-selected task, executes controlled steps through adapters, verifies actual outcomes, preserves evidence and audit records, and returns a structured result.

## Current status

**Implemented: Phase 0 → Phase 1 MVP vertical slice.**

The repository was documentation-only. The smallest production-sensible stack selected is:

- **TypeScript** for explicit contracts and strict domain modeling.
- **Hono** for a minimal HTTP boundary.
- **Cloudflare Pages/Workers** for an edge-deployable runtime using Web APIs only.
- **Vitest** for unit, adapter-contract, integration, API, and end-to-end tests.
- **In-memory repositories** behind interfaces, as explicitly allowed for Phase 1.

No UI, real provider integration, queue, scheduler, or unrelated operator feature was added.

## Proven execution flow

```text
Task
→ Normalize
→ Validate
→ Plan
→ Policy Check
→ Execute
→ Observe
→ Verify
→ Persist Evidence
→ Audit
→ Deliver Result
```

## Completed features

- Task, run, step, evidence, audit, policy, adapter, error, verification, and delivery contracts.
- Enforced run and step state machines.
- Deterministic sequential planner and execution engine.
- Provider-independent adapter registry and tool contract.
- Deterministic `mock.tool` adapter with read/write behavior.
- Risk levels 0–3 with `ALLOW`, `REQUIRE_APPROVAL`, and `DENY` decisions.
- Task-level duplicate suppression and stable step idempotency keys.
- Bounded retry for retryable, idempotency-protected operations.
- Verification-first handling for unknown mutation outcomes.
- Execution and verification evidence with integrity hashes.
- Append-oriented, redacted audit events.
- Structured delivery results with outputs, evidence, warnings, errors, and next action.
- Secret redaction at adapter, evidence, audit, and delivery boundaries.
- Automated coverage of all 15 mandatory scenarios in `docs/08_TESTING_AND_ACCEPTANCE.md`.

## API entry points

| Method | URI | Purpose |
|---|---|---|
| `GET` | `/` | Service metadata and implemented flow |
| `GET` | `/health` | Health check |
| `POST` | `/api/runs` | Normalize, validate, and execute one task |
| `GET` | `/api/runs/:runId` | Inspect an in-memory run, steps, evidence, and audit trace |

### Execute the sample task

```bash
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  --data @examples/read-only-task.json
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Sandbox preview:

```bash
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/health
```

Full quality gate:

```bash
npm run check
```

## Data architecture

### Models

- `Task 1 → N Run`
- `Run 1 → N Step`
- `Step 1 → N Evidence`
- `Run 1 → N AuditEvent`

### Storage

Phase 1 uses `InMemoryRunnerStore` through the replaceable `RunnerStore` interface. Tasks, runs, steps, evidence, audits, and idempotency results are process-local and are not durable across restarts or isolate eviction.

Evidence and audit collections are append-oriented through their public repository methods. Returned values are structured clones so callers cannot mutate stored records by reference.

## Security and policy behavior

- Level 0 and level 1 operations execute automatically unless explicitly denied.
- Level 2 and level 3 operations require a matching valid approval.
- Rejected or disallowed actions are blocked before adapter execution.
- Unknown side-effect outcomes are verified and are never blindly retried.
- Tool output remains untrusted data and cannot redefine policy.
- Sensitive keys such as tokens, passwords, API keys, and credentials are redacted.
- No secrets are stored in source control.

## Deployment

- **Platform:** Cloudflare Pages
- **Configuration:** `wrangler.jsonc`
- **Production branch:** `main`
- **Status:** Active — verified 2026-09-10
- **Production URL:** https://runner-os.pages.dev
- **Deployment URL:** https://1970f857.runner-os.pages.dev

The in-memory runtime is suitable for proving Phase 0 → Phase 1 behavior but not for production durability. Cloudflare D1 is the recommended next persistence implementation.

## Not yet implemented

- Durable D1 persistence and restart recovery.
- Cross-isolate/concurrent idempotency claims.
- Resume flow for runs waiting on approval.
- Durable approval records.
- Unknown-outcome recovery beyond the current verification attempt.
- Real external adapter.
- Authentication, tenant isolation, rate limiting, metrics, and operations runbooks.
- Queue, scheduling, webhooks, and parallel execution.

## Exact next recommended phase

**Phase 2 — Persistence:** implement a Cloudflare D1-backed `RunnerStore` for tasks, runs, steps, evidence, audit events, and idempotency records; add migrations and restart-recovery tests. Do not add a real connector or operator UI before this persistence exit gate passes.
