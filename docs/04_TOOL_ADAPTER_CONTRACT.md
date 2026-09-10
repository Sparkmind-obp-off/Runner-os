# Runner OS — Tool Adapter Contract

## Purpose

The adapter contract isolates Runner OS from external providers and APIs.

Every tool adapter must expose a stable interface so the execution engine does not need provider-specific logic.

## Contract

```text
ToolAdapter
├── name
├── version
├── capabilities()
├── validate(input, context)
├── execute(input, context)
└── verify(execution_result, expected_outcome, context)
```

## Capability Metadata

An adapter should declare:

- supported actions
- read/write behavior
- side-effect level
- authentication requirements
- idempotency support
- verification support
- rate-limit behavior
- retry safety

## Validation

`validate()` checks schema, required fields, policy prerequisites, and provider-specific constraints without causing side effects.

## Execution

`execute()` performs the requested operation and returns a normalized result.

Normalized result should include:

- `success`
- `provider`
- `operation`
- `provider_request_id` when available
- `output`
- `error`
- `retryability`
- `side_effect_reference`

## Verification

`verify()` independently checks whether the intended outcome actually exists.

Examples:
- API create → fetch created resource.
- Send message → inspect provider delivery/message record.
- Update record → read record and compare expected fields.
- File write → read/check hash.

## Error Contract

Adapters must normalize errors into:

- `VALIDATION_ERROR`
- `AUTH_ERROR`
- `RATE_LIMITED`
- `TIMEOUT`
- `TRANSIENT_PROVIDER_ERROR`
- `NOT_FOUND`
- `CONFLICT`
- `PERMISSION_DENIED`
- `UNKNOWN_PROVIDER_ERROR`

Each error must declare whether retry is safe.

## Idempotency

If the provider supports native idempotency, the adapter should pass the Runner OS idempotency key through.

If not, the adapter must document the safest deduplication strategy. Runner OS must never blindly retry an unknown side effect.

## Example Adapters for the MVP

1. `mock.tool` — deterministic local test adapter.
2. `http.tool` — controlled HTTP/API adapter.
3. `github.tool` — future repository operations adapter.
4. `make.tool` — future automation adapter.

Provider adapters must remain optional modules; the core runner must function without them.
