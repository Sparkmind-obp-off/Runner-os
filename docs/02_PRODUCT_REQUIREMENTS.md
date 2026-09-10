# Runner OS — Product Requirements

## 1. Product Definition

Runner OS is an execution runtime for AI-driven business systems. It converts a structured task into a controlled, observable, verifiable run and returns evidence-backed results.

**Core loop:**

`Task → Normalize → Plan → Policy Check → Execute → Observe → Verify → Persist Evidence → Deliver`

Runner OS is not the AI Business Operator itself. It is the execution substrate beneath operators, agents, automations, and future voice interfaces.

## 2. Problem

AI systems can reason about what should happen but often lack a reliable execution layer. Typical failures include unclear tool contracts, duplicate actions, missing verification, weak auditability, silent failures, and provider lock-in.

Runner OS solves this by making execution explicit and stateful.

## 3. Goals

- Execute structured tasks through deterministic steps.
- Support multiple tool/provider adapters behind one contract.
- Make every important action observable.
- Verify outcomes rather than trusting tool responses.
- Prevent unsafe or duplicate execution.
- Preserve evidence and an audit trail.
- Support retries and recovery without creating duplicate side effects.
- Keep the core independent from any single AI or automation provider.

## 4. Non-Goals

- Building a general-purpose LLM.
- Replacing Make, n8n, Cloudflare, GitHub, or other providers.
- Fully autonomous execution of high-risk actions without policy/approval.
- Building the final AI Business Operator UI in the first release.
- Solving every integration on day one.

## 5. Primary Users

1. **System builder** — defines tasks, tools, policies, and workflows.
2. **AI operator** — produces or requests executable tasks.
3. **Human approver** — authorizes risky actions.
4. **System administrator** — observes runs, failures, evidence, and health.

## 6. MVP Capabilities

### P0
- Task schema.
- Run lifecycle/state machine.
- Step execution engine.
- Tool adapter interface.
- Policy/risk evaluation.
- Idempotency keys.
- Verification stage.
- Evidence record.
- Audit events.
- Structured delivery result.
- Retry classification.

### P1
- Persistent run store.
- Tool registry.
- Approval gate.
- Run replay/debug view.
- Metrics and structured logs.

### P2
- Queue/worker execution.
- Scheduling.
- Webhook triggers.
- Parallel step execution.
- Provider-specific adapters.

## 7. Acceptance Criteria

A first vertical slice is acceptable when it can:

1. Accept a valid task.
2. Create a unique run.
3. Validate policy and input.
4. Execute at least one tool through the adapter contract.
5. Capture the tool result.
6. Verify the expected outcome.
7. Persist evidence and audit events.
8. Return a deterministic delivery result.
9. Safely retry a retryable failure.
10. Refuse or pause a policy-blocked action.

## 8. Product Principles

- Execution is a product capability, not an implementation detail.
- Verification is mandatory for meaningful side effects.
- Evidence is part of the result.
- Risk must be explicit.
- Idempotency is required wherever duplicate side effects are possible.
- Human approval is a feature, not a workaround.
- Provider integrations remain replaceable.
