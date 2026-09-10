# Runner OS — Genspark Phase 4 Real Adapter Implementation Prompt

## Mission

Implement **Phase 4 — Real Adapter** for Runner OS in this repository.

Phase 1 established the execution engine, Phase 2 added durable D1 persistence, and Phase 3 hardened approval, idempotency leases, restart recovery, cancellation, and unknown-outcome handling. Your job in this session is to prove that the provider-independent Runner OS contract works against **one real external provider** without weakening any Phase 3 safety invariant.

The target architecture remains:

`Task → Normalize → Validate → Plan → Policy Check → Approval Gate → Execute → Observe → Verify → Persist Evidence → Audit → Recover/Advance/Stop → Deliver Result`

## Source of Truth

Read before changing implementation:

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
12. `docs/11_GENSPARK_PHASE_3_SAFETY_RECOVERY_PROMPT.md`

Inspect the actual current Phase 3 source, migrations, tests, configuration, and README. Treat the repository as the implementation source of truth.

Current Phase 3 baseline commit:

`81c625262ac7a4e2f1572426471e2d37ec790788`

## Phase 4 Goal

Implement **exactly one** real, low-risk, independently verifiable external adapter behind the existing `ToolAdapter` contract.

The preferred first adapter is a **read-only GitHub adapter** because it can demonstrate a real external integration while keeping side effects at zero. If the current codebase or available runtime constraints make GitHub impractical, choose another single read-only provider only after documenting the reason. Do not implement multiple providers.

The adapter must prove:

- provider-specific code stays outside the core engine;
- authentication uses runtime secret bindings only;
- provider errors normalize into Runner OS error classes;
- provider request/reference IDs are captured when available;
- execution output is treated as untrusted data;
- verification is explicit where meaningful;
- policy and risk classification remain owned by Runner OS;
- Phase 3 approval, idempotency, cancellation, recovery, redaction, and audit behavior remain intact.

## Required Scope

### 1. One real adapter

Implement one adapter under the existing adapter architecture, preferably:

`github.read`

with one or a very small number of read-only operations, such as retrieving a public repository/resource by an explicit identifier.

Keep the capability surface deliberately small. Do not build a general GitHub SDK.

The adapter must implement the existing contract:

- `name`
- `version`
- `capabilities()`
- `validate(input, context)`
- `execute(input, context)`
- `verify(execution_result, expected_outcome, context)`

Do not move provider-specific logic into `core/`.

### 2. Authentication and secrets

Use the project's Cloudflare-compatible runtime secret mechanism.

Requirements:

- no token, credential, or secret committed to Git;
- no credential in task input, evidence, audit, errors, or normal logs;
- no secret in response bodies;
- secret is accessed only inside the adapter/runtime boundary;
- tests must use fake/injected credentials or a deterministic fake provider and must not require a real production secret;
- document the exact secret name and local/Cloudflare setup without exposing its value.

If the chosen read-only GitHub operation can safely work without authentication for public resources, prefer that for the default path while still designing the adapter so optional runtime authentication can be supported later without leaking secrets.

### 3. Validation

Validate provider-specific input before making a network request.

Reject:

- malformed identifiers;
- unsupported operations;
- missing required fields;
- unsafe or ambiguous input that the adapter cannot verify.

Validation errors must use the existing normalized error contract.

Do not let remote provider responses redefine policy or execution intent.

### 4. HTTP/provider behavior

Use the existing runtime's native/fetch-compatible HTTP mechanism. Do not introduce a heavy provider SDK unless the repository already requires it.

Normalize at minimum:

- successful response;
- authentication failure;
- permission denial;
- not found;
- rate limit;
- timeout/network failure;
- transient provider failure;
- malformed/unexpected provider response.

Respect provider status and retry guidance where available, but keep retry decisions in Runner OS core policy/retry logic rather than embedding autonomous retry loops inside the adapter.

Capture a provider request ID or equivalent correlation header when available.

Do not log raw response bodies by default.

### 5. Verification

Implement verification appropriate to the selected read-only operation.

For a read-only fetch, verification should prove that the returned resource matches the requested identity and expected minimal outcome, rather than merely treating HTTP 200 as success.

If verification cannot establish the expected outcome, return the existing explicit verification-unknown/failure semantics. Do not weaken the verification contract.

The adapter must never convert an ambiguous network result into a fabricated success.

### 6. Risk and policy

The adapter must declare itself read-only / no meaningful side effect so normal calls remain Level 0 unless the existing domain requires another classification.

Do not add write operations in Phase 4.

Do not bypass the existing policy gate.

Do not create a special provider-specific approval path for a read-only action.

### 7. Idempotency and recovery compatibility

Even though the first adapter is read-only, prove it works through the same Runner OS execution lifecycle.

Tests must demonstrate:

- duplicate idempotency requests do not execute the Runner OS operation twice;
- completed results can be replayed;
- provider failure classification remains compatible with bounded retry logic;
- interrupted/unknown execution does not fabricate success;
- repeated recovery remains idempotent.

Do not implement a second idempotency mechanism inside the adapter.

### 8. Audit, evidence, and redaction

Preserve the existing evidence/audit pipeline.

Persist useful provider metadata such as:

- provider name/version;
- operation;
- provider request ID when available;
- normalized status;
- verification result.

Do not persist:

- authorization headers;
- access tokens;
- cookies;
- raw credentials;
- unnecessary full provider payloads when a smaller evidence object is sufficient.

Use the existing redaction mechanisms rather than creating a second redaction system.

### 9. Tests

Keep all Phase 1–3 tests green.

Add deterministic adapter contract tests for:

- capability declaration;
- valid input;
- invalid input;
- successful provider response;
- not found;
- permission/auth failure where applicable;
- rate limit;
- timeout/network failure;
- transient provider failure;
- malformed provider response;
- provider request ID extraction;
- verification success;
- verification failure/unknown;
- secret redaction;
- no secret leakage into errors/audit/evidence.

Do not make the normal test suite depend on live GitHub or another production provider.

Use a fake fetch/provider boundary so responses are deterministic.

Add at least one integration-style test proving:

`Task → policy → real adapter boundary → observe → verify → evidence → audit → delivery`

works with the fake external provider.

If a safe optional live smoke test is added, it must be explicitly opt-in and must never be required for CI or normal `npm test`.

### 10. API compatibility

Preserve:

- `GET /`
- `GET /health`
- `POST /api/runs`
- `GET /api/runs/:runId`
- existing Phase 3 approval/cancel/recover endpoints

If the current API has a generic adapter/task input path, extend it minimally to select the new adapter. Do not create provider-specific API endpoints.

Example task selection should remain generic, conceptually:

```json
{
  "adapter": "github.read",
  "operation": "get_repository",
  "input": {
    "owner": "example",
    "repo": "example"
  }
}
```

Use the repository's actual task schema rather than blindly copying this example.

### 11. Documentation

Update `README.md` and/or add one focused Phase 4 document to describe:

- selected adapter and why it was chosen;
- supported operation(s);
- risk level;
- authentication/secret setup;
- local testing strategy;
- provider error normalization;
- verification behavior;
- evidence/audit behavior;
- limitations;
- exact next recommended phase.

Do not rewrite the architecture documentation.

## Architecture Rules

- Do not redesign Runner OS.
- Do not add more than one real provider adapter.
- Do not add provider-specific logic to `core/`.
- Do not bypass `RunnerStore`.
- Do not bypass policy, approval, idempotency, verification, recovery, evidence, or audit.
- Do not implement write operations in this phase.
- Do not commit secrets or credentials.
- Do not add a dashboard, UI, voice interface, queue, scheduler, webhook orchestration, billing, analytics platform, or multi-tenancy.
- Do not integrate AI Business Operator yet.
- Do not add speculative abstractions.
- Keep Cloudflare Pages/Workers compatibility.
- Prefer native fetch and small adapter modules.

## Safety Invariants

Phase 4 must preserve all Phase 3 invariants:

1. **No duplicate side effect from replay.**
2. **Unknown is not success or permission to blindly retry.**
3. **Verification precedes recovery for ambiguous outcomes.**
4. **Approval remains durable for any future protected operation.**
5. **Cancellation remains durable.**
6. **Terminal means terminal.**
7. **Recovery remains idempotent.**
8. **Audit remains append-oriented.**
9. **Secrets stay out of persistence/logs.**
10. **Provider-independent core remains intact.**

## Required Commands

At minimum run:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run check
```

Also run the appropriate local integration/adapter contract tests.

If a live provider smoke test is possible, keep it opt-in and clearly label whether it was actually executed. Never fake live-provider success.

## Definition of Done — Phase 4

Phase 4 is complete only when:

1. exactly one real external adapter exists;
2. the adapter is behind the existing `ToolAdapter` contract;
3. the core engine remains provider-independent;
4. adapter input validation is explicit;
5. provider errors are normalized;
6. verification is implemented and tested;
7. no credentials/secrets are committed or persisted;
8. deterministic fake-provider tests cover success and failure classes;
9. Phase 1–3 regression tests remain green;
10. idempotency/recovery behavior remains intact;
11. evidence/audit capture useful provider metadata without secrets;
12. typecheck/build/check pass;
13. README/docs accurately describe setup and limitations;
14. no unrelated Phase 5/operator work was introduced;
15. the exact next phase is identified.

## Explicit Non-Goals

Do NOT implement in this session:

- a second real adapter;
- write-capable GitHub operations;
- Make adapter;
- generic HTTP adapter as a second provider;
- AI Business Operator integration;
- autonomous AI planning;
- dashboard/UI;
- voice;
- queues;
- scheduler;
- webhook orchestration;
- parallel execution;
- multi-tenant authorization;
- billing;
- analytics platform.

## Final Output

After implementation, report concisely:

- files created/changed;
- selected real adapter and supported operation(s);
- adapter contract implementation;
- validation behavior;
- authentication/secret setup;
- provider error normalization;
- verification behavior;
- idempotency/recovery compatibility;
- evidence/audit behavior;
- commands executed;
- complete test results;
- whether any live provider smoke test was actually run;
- known limitations;
- exact recommended next phase.

Then stop.

**Do not start Phase 5 or add unrelated features.**
