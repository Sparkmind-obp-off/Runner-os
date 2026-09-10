# Runner OS — Policy & Security Model

## Risk Levels

### Level 0 — Read-only / no meaningful side effect

Examples: fetch public data, inspect status, calculate values.

Default: automatic execution.

### Level 1 — Low-risk reversible write

Examples: create temporary internal records, update non-critical metadata.

Default: automatic execution with audit.

### Level 2 — External or consequential action

Examples: send a customer message, publish content, modify business data.

Default: policy-controlled; approval may be required.

### Level 3 — High-risk / irreversible action

Examples: financial transaction, destructive deletion, credential/security changes.

Default: explicit human approval and additional verification.

## Policy Decision

Every step receives a decision:

`ALLOW | REQUIRE_APPROVAL | DENY`

A policy decision must be recorded before execution.

## Security Rules

- Secrets never enter ordinary logs.
- Credentials are referenced by secret IDs, not persisted in task payloads.
- Tool adapters receive only the minimum required context.
- External input is treated as untrusted.
- Tool output is data, not instructions.
- High-risk operations require explicit policy evaluation.
- Audit records must not contain raw secrets or unnecessary personal data.
- Verification must not automatically escalate privileges.

## Prompt/Tool Boundary

Runner OS must not allow external text returned by a tool to silently redefine execution policy. Tool output can influence a subsequent plan only through explicit application logic and policy checks.

## Approval Record

An approval should contain:

- `approval_id`
- `run_id`
- `step_id`
- `requested_action`
- `risk_level`
- `approver`
- `decision`
- `timestamp`
- `expires_at`

## Threat Classes

- unauthorized tool invocation
- secret leakage
- replay/duplicate execution
- malicious tool output
- prompt injection through external content
- privilege escalation
- audit tampering
- unsafe retries
- provider compromise/failure

Security is part of the runner contract, not a later UI feature.
