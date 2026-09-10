# Runner OS

Runner OS is a provider-independent execution runtime that converts structured tasks into policy-checked, verified, evidence-backed results.

## Current status

**Phase 2 — Durable Persistence is complete.** The execution flow remains:

`Task → Normalize → Validate → Plan → Policy Check → Execute → Observe → Verify → Persist Evidence → Audit → Deliver Result`

The core engine remains provider-agnostic. `RunnerStore` accepts synchronous or asynchronous implementations; Phase 1 tests use `InMemoryRunnerStore`, while Cloudflare requests with a `DB` binding use `D1RunnerStore`.

## Completed features

- Strict task/run/step/evidence/audit contracts and state machines.
- Deterministic sequential planner, policy gate, bounded retries, cancellation, unknown-outcome verification, and mock adapter.
- Durable D1 storage for tasks, runs, steps, evidence, audit events, and idempotency claims/results.
- Database-backed idempotency claims using a primary-key uniqueness constraint.
- Append-only evidence and audit inserts with redaction and preserved integrity hashes.
- Restart/store re-instantiation, schema reproducibility, serialization, terminal-state, failure, and concurrency tests.
- All Phase 1 mandatory scenarios remain covered.

## API entry points

| Method | URI | Purpose |
|---|---|---|
| `GET` | `/` | Service metadata and execution flow |
| `GET` | `/health` | Health check |
| `POST` | `/api/runs` | Execute one structured task |
| `GET` | `/api/runs/:runId` | Retrieve durable run, steps, evidence, and audit |

```bash
curl -X POST http://localhost:3000/api/runs \
  -H 'content-type: application/json' \
  --data @examples/read-only-task.json
```

## D1 architecture

Migration `migrations/0001_runner_store.sql` creates only the current domain tables:

- `tasks`
- `runs`
- `steps`
- `evidence`
- `audit_events`
- `idempotency_claims`

Foreign keys protect run-owned records, indexes cover run/status/order lookups, and SQL checks constrain statuses and risk levels. JSON fields use canonical key ordering for deterministic serialization. Terminal run/step transitions are rejected by both the state machine and persistence update guards.

The `DB` binding in `wrangler.jsonc` targets `runner-os-production`. Replace the placeholder database ID with the ID returned when creating the production database.

## Setup and migrations

```bash
npm install
npm run db:migrate:local
npm run typecheck
npm test
npm run build
npm run check
```

Local preview:

```bash
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/health
```

Production D1 setup (BYOK Cloudflare account):

```bash
npx wrangler d1 create runner-os-production
# Put the returned database_id in wrangler.jsonc
npm run db:migrate:prod
npm run deploy
```

Tests use a local SQLite-backed D1 contract harness; they require no Cloudflare account or production credentials. Wrangler local migration additionally verifies migration compatibility against local D1.

## Durability and concurrency guarantees

- Completed and failed runs, steps, execution/verification evidence, audits, and idempotency results survive Worker/store re-instantiation.
- `idempotency_claims.idempotency_key` is the database primary key. `INSERT OR IGNORE` makes claim ownership atomic within one D1 database: only one competing run can claim a stable key.
- A duplicate completed request receives the original persisted result. A duplicate arriving while the owner is still running is suppressed with an in-progress warning and performs no adapter side effect.
- Guarantees are scoped to one configured D1 database. They do not coordinate separate databases/accounts or a provider action executed outside Runner OS.
- D1 provides transactional semantics per statement; this phase does not implement queues, leases, abandoned-claim recovery, or parallel execution.
- Evidence/audit APIs are append-oriented. Duplicate primary keys fail rather than overwrite records.
- Sensitive key names are redacted before evidence, audit, task input, step input/output, and idempotency result JSON are persisted.

## Data model

`Task 1 → N Run`, `Run 1 → N Step`, `Step 1 → N Evidence`, and `Run 1 → N AuditEvent`. Validation failures retain a run with a nullable database task reference represented as `unresolved` in the domain model.

## Deployment

- **Platform:** Cloudflare Pages + D1
- **Production branch:** `main`
- **Binding:** `DB`
- **Secrets:** none required for the mock adapter; never commit `.dev.vars`, `.env`, tokens, or credentials.

## Known limitations / not implemented

- No abandoned idempotency-claim lease or resume mechanism.
- No durable approval workflow beyond approval data included in the submitted task.
- No cross-database idempotency coordination.
- No real external adapters, authentication, tenancy, queues, scheduling, webhooks, parallel execution, UI, or operator integration.
- Unknown mutation outcomes are verified once and not autonomously recovered later.

## Exact next recommended phase

**Phase 3 — Safety & Recovery hardening:** add durable approval/resume records, idempotency claim leases and abandoned-run recovery, and restart-aware cancellation/recovery semantics. Do not add real providers or an operator UI until that reliability gate passes.
