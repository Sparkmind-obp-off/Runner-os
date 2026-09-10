# Runner OS

Runner OS is a provider-independent execution runtime that turns structured tasks into policy-checked, verified, evidence-backed results.

## Current status

**Phase 4 — Real Adapter is complete.**

`Task → Normalize → Validate → Plan → Policy Check → Approval Gate → Execute → Observe → Verify → Persist Evidence → Audit → Recover/Advance/Stop → Deliver Result`

The core remains provider-independent. `RunnerStore` has in-memory and Cloudflare D1 implementations; all safety decisions pass through that abstraction. The first real provider module is the read-only `github.read` adapter.

## URLs

- **Production:** https://runner-os.pages.dev
- **GitHub:** https://github.com/Sparkmind-obp-off/Runner-os
- **Health:** https://runner-os.pages.dev/health

## Completed features

- Strict task, run, step, evidence, approval, recovery, and audit contracts.
- Deterministic sequential planning and explicit run/step state machines.
- Policy enforcement for risk levels 0–3.
- Durable approval requests and idempotent approval decisions.
- Durable cancellation intent across runtime/store re-instantiation.
- D1-backed idempotency claims with owner tokens, leases, renewal, deterministic expiry, and atomic recovery.
- Restart recovery that classifies non-terminal runs instead of blindly replaying them.
- Verification-first handling for interrupted or unknown side effects.
- Append-oriented, redacted evidence and safety audit events.
- Completed idempotency-result replay without duplicate Runner OS execution.
- Phase 1 and Phase 2 regression coverage plus deterministic Phase 3 safety tests.
- One real external adapter, `github.read`, with the single `get_repository` operation.
- Native-fetch GitHub integration with explicit validation, normalized failures, request-ID capture, minimal untrusted output, and identity verification.
- Deterministic fake-fetch contract/integration tests; the normal suite requires no network or production secret.

## API entry points

| Method | URI | Purpose |
|---|---|---|
| `GET` | `/` | Service metadata and execution flow |
| `GET` | `/health` | Health check |
| `POST` | `/api/runs` | Submit and execute one structured task |
| `GET` | `/api/runs/:runId` | Retrieve run, steps, evidence, audit, and approval |
| `POST` | `/api/runs/:runId/approval` | Submit `approved` or `rejected` durable decision |
| `POST` | `/api/runs/:runId/cancel` | Persist idempotent cancellation intent |
| `POST` | `/api/runs/:runId/recover` | Explicitly recover one non-terminal run |

Approval request:

```bash
curl -X POST http://localhost:3000/api/runs/RUN_ID/approval \
  -H 'content-type: application/json' \
  -d '{"decision":"approved","actor":"approver-reference","reason":"Reviewed"}'
```

Cancellation and recovery:

```bash
curl -X POST http://localhost:3000/api/runs/RUN_ID/cancel \
  -H 'content-type: application/json' \
  -d '{"actor":"operator-reference"}'
curl -X POST http://localhost:3000/api/runs/RUN_ID/recover
```

No approval UI, scheduler, queue, or provider-specific cancellation API is included.

## Phase 4 GitHub read adapter

`github.read` was selected because a repository lookup is a real, independently observable provider interaction with no meaningful side effect. Its only capability is `get_repository`, declared as read-only Level 0. Runner OS still owns risk classification, policy, lifecycle idempotency, retries, verification, evidence, recovery, and audit.

Example task step using the existing generic schema:

```json
{
  "tool": "github.read",
  "action": "get_repository",
  "input": {
    "operation": "get_repository",
    "owner": "octocat",
    "repo": "Hello-World"
  },
  "expected_outcome": {
    "full_name": "octocat/Hello-World",
    "visibility": "public"
  },
  "risk_level": 0
}
```

Validation rejects missing/malformed identifiers, unknown operations, ambiguous repository names, extra fields, and credential-bearing task input before network access. The adapter uses native `fetch`; it does not retry internally. GitHub HTTP/network outcomes normalize to `AUTH_ERROR`, `PERMISSION_DENIED`, `NOT_FOUND`, `RATE_LIMITED`, `TIMEOUT`, `TRANSIENT_PROVIDER_ERROR`, or `UNKNOWN_PROVIDER_ERROR`, while Runner OS applies the bounded retry policy.

A successful HTTP response is not sufficient. Verification compares the returned owner/name/full name to the explicit request, then checks only supported expected fields. It returns `PASS`, `FAIL`, or `UNKNOWN`; ambiguity is never fabricated as success. Persisted execution evidence contains provider name/version, operation, request ID when supplied by GitHub, normalized status, and a reduced repository object. Authorization headers, cookies, raw error bodies, and unnecessary provider payload fields are excluded.

Public repository lookup works without authentication. Optional authentication is read only from the Cloudflare runtime secret `GITHUB_TOKEN` inside the adapter boundary:

```bash
# Local only; .dev.vars is gitignored
printf 'GITHUB_TOKEN="%s"\n' 'YOUR_VALUE' > .dev.vars

# Cloudflare Pages BYOK; value is read from stdin and is never committed
printf '%s' "$GITHUB_TOKEN" | npx wrangler pages secret put GITHUB_TOKEN --project-name runner-os
```

The deterministic tests inject fake `fetch` and a fake token. They never require live GitHub or a production credential.

## Phase 3 safety model

### Durable approval

Risk level 2/3 actions cannot execute without a valid approval. A pending record contains a stable approval/run/step identity, requested action and risk, timestamps, status, and non-secret actor/reason metadata. Pending approval survives restart. Approval submission is atomic and idempotent when the same decision is repeated. Rejection and effective expiry are terminal barriers and are audited.

Legacy task-input approvals remain accepted for Phase 1 compatibility, but are normalized into the durable approval table before policy evaluation. New approval flows should use the approval endpoint.

### Idempotency ownership and leases

A claim has a stable key, owning run, owner token, `claimed`/`completed` lifecycle, heartbeat, and lease expiry. Database uniqueness prevents two live claims for one key in the configured D1 database. Renewal requires the current owner token. Recovery uses an atomic conditional update and succeeds only after deterministic lease expiry. Completed results remain replayable.

An approval wait deliberately expires its execution lease so the same durable run can resume under a new owner after approval. This does not release the idempotency key to another run.

### Restart recovery

Recovery is explicit via `RunnerEngine.recover`, `recoverAll`, or the recovery endpoint:

- `queued`, `validating`, and `planning`: safely resume deterministic non-side-effecting work when durable task state exists.
- `awaiting_approval`: remain pending, stop on rejection/expiry, or resume after a valid durable approval.
- `executing`/`verifying` read-only work: may resume under normal state-machine and lease rules.
- interrupted side-effecting work: classify as unknown and verify before any retry decision.
- terminal runs: return their persisted result and are never resurrected.

Recovery attempts and decisions are persisted/audited and repeated recovery cannot duplicate an already verified or blocked side effect.

### Unknown outcomes

Internal recovery classifications are:

- `KNOWN_SUCCESS`
- `KNOWN_FAILURE`
- `UNKNOWN_REQUIRES_VERIFICATION`
- `RECOVERY_BLOCKED`

For an ambiguous mutation, Runner OS persists the classification and evidence, invokes adapter verification, and then:

1. verification `PASS` → persist success; never execute again;
2. verification `FAIL` → retry only if policy, approval, adapter idempotency, cancellation, and lease ownership permit it;
3. verification `UNKNOWN` → stop in explicit `blocked` / `RECOVERY_BLOCKED` state; never guess.

### Cancellation

Cancellation intent is persisted on the run. Once observed, no new side-effecting step begins. An external request already in flight may still finish; cancellation does not claim rollback. Interrupted side effects are verified before finalization. Repeated cancellation requests are idempotent and only the first request adds the request audit event.

### Audit and redaction

Safety audit events include approval requested/decided/expired, cancellation requested/observed, claim acquisition/renewal/recovery, recovery start/completion/blocking, unknown-outcome classification, verification attempts/results, and recovery retry allow/deny decisions. Evidence and metadata pass through recursive sensitive-key redaction. The GitHub token is optional and is never accepted in task input, returned, logged, audited, evidenced, or persisted.

## D1 data architecture

Migration `migrations/0001_runner_store.sql` provides Phase 2 tables:

- `tasks`, `runs`, `steps`, `evidence`, `audit_events`, `idempotency_claims`

Migration `migrations/0002_safety_recovery.sql` upgrades Phase 2 without rewriting it:

- adds durable cancellation and recovery classifications to runs;
- adds step recovery classification;
- adds owner-token/heartbeat/lease/recovery fields to idempotency claims;
- creates `approvals` and `recovery_attempts`;
- adds approval, lease, run-recovery, and recovery-history indexes.

Guarantees are scoped to one configured D1 database. SQL uniqueness and conditional updates provide claim/decision concurrency protection within that scope.

## Setup, migrations, and tests

```bash
npm install
npm run db:migrate:local
npm run typecheck
npm test
npm run build
npm run check
```

The tests use a local SQLite-backed D1 contract harness. They apply Phase 2 then Phase 3 migrations in order, proving both upgrade and fresh-schema behavior without production credentials. GitHub adapter tests use deterministic fake-fetch responses for success, auth/permission denial, not found, rate limits, timeout/network failure, provider failure, malformed payloads, request IDs, verification, redaction, bounded retry, idempotency replay, and restart recovery.

Local preview:

```bash
npm run build
pm2 start ecosystem.config.cjs
curl http://localhost:3000/health
```

## Cloudflare BYOK deployment

- **Platform:** Cloudflare Pages + D1
- **Production branch:** `main`
- **D1 binding:** `DB`
- **Database name:** `runner-os-production`
- **Optional secret:** `GITHUB_TOKEN` for higher GitHub API limits/private repository reads; public repository reads work without it.
- Never commit `.dev.vars`, `.env`, tokens, authorization headers, or credentials.

```bash
npx wrangler d1 create runner-os-production       # first setup only
# Put the returned database_id in wrangler.jsonc.
npm run db:migrate:prod
npm run deploy
```

The currently configured production D1 ID must belong to the Cloudflare account selected through the Deploy panel.

## Known limitations / not implemented

- The only real provider adapter is `github.read`; it supports only `get_repository` and performs no writes.
- Unauthenticated GitHub requests use public API rate limits; optional `GITHUB_TOKEN` scope/permissions are managed outside Runner OS.
- No provider-specific cancellation API; an in-flight fetch can only be bounded by timeout/Worker lifetime.
- No automatic queue/scheduler; recovery is invoked explicitly or by application code.
- No parallel execution or cross-database idempotency coordination.
- No authentication, multi-tenant authorization, dashboard, voice, webhooks, billing, or analytics platform.
- A verification-inconclusive side effect is intentionally blocked and requires a new explicitly authorized operational path; blocked/terminal runs are never silently resumed.
- Legacy inline approvals are retained only for backward compatibility; production callers should use a separately authorized approval endpoint boundary.

## Exact next recommended phase

**Phase 5 — Operator Integration:** expose the stable provider-independent Runner OS task API to an upstream operator while Runner OS retains policy, approval, execution state, verification, evidence, and recovery ownership. Do not add autonomous planning, UI, or further providers before that boundary is specified and tested.
