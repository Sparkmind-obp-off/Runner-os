# Runner OS — Execution Engine Specification

## Execution Pipeline

```text
receive task
  ↓
normalize
  ↓
validate
  ↓
plan steps
  ↓
policy check
  ↓
approval gate (if required)
  ↓
execute step
  ↓
observe result
  ↓
verify outcome
  ↓
persist evidence + audit
  ↓
advance / retry / recover / stop
  ↓
deliver result
```

## Engine Responsibilities

The engine owns orchestration, not provider-specific behavior.

It must:

- create and manage runs
- enforce state transitions
- resolve tool adapters
- enforce policy decisions
- manage retries
- preserve idempotency
- invoke verification
- persist evidence
- emit audit events
- produce the final delivery result

## Planner Boundary

The planner may be deterministic, rule-based, or AI-assisted. The execution engine must treat the resulting plan as untrusted input and validate every executable step before side effects occur.

## Retry Policy

Retry only when:

1. the error is classified retryable;
2. the operation is safe to retry or protected by idempotency;
3. retry budget remains;
4. policy still allows the action.

Use bounded exponential backoff with jitter in production.

## Unknown Outcome

If execution times out after a request may have reached the provider, status must become `unknown` rather than automatically retrying a side effect.

Recovery should attempt verification first.

## Cancellation

Cancellation prevents new side effects. An already-running provider request may not be cancellable; the engine must verify the final state before closing the run.

## Determinism

Given the same task, policy, adapter version, and persisted execution state, the engine should make the same state-transition decisions. External provider responses are naturally variable and must be captured as evidence.

## Concurrency

MVP: sequential steps.

Future: parallel execution only when dependencies, shared resources, and idempotency rules explicitly allow it.

## Delivery Result

The engine returns:

```json
{
  "run_id": "...",
  "status": "completed",
  "summary": "...",
  "outputs": [],
  "evidence": [],
  "warnings": [],
  "errors": []
}
```

A delivery result is not considered successful merely because a provider returned HTTP 200; verification determines outcome status.
