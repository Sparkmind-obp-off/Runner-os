# Runner OS — Testing & Acceptance

## Testing Layers

### Unit

Test state transitions, policy decisions, retry classification, idempotency, normalization, and result mapping.

### Contract

Every adapter must pass the same adapter contract suite.

### Integration

Test engine + persistence + adapter + verification together.

### End-to-End

Test complete task lifecycle from submission to delivery result.

## Mandatory Scenarios

1. Successful read-only task.
2. Successful low-risk write.
3. Validation failure.
4. Policy denial.
5. Approval required and approved.
6. Approval required and rejected.
7. Retryable provider error.
8. Retry budget exhausted.
9. Timeout with unknown outcome.
10. Verification failure.
11. Duplicate idempotency key.
12. Cancellation before execution.
13. Cancellation during execution.
14. Adapter unavailable.
15. Malicious/untrusted tool output does not change policy.

## Acceptance Gate

MVP is ready only when:

- all mandatory scenarios have automated tests;
- no secret appears in logs or evidence;
- retry behavior is bounded;
- side-effecting operations have verification or an explicit exception;
- every terminal run has a final status;
- every executed step has an audit trail;
- failures are actionable and classified.

## Reliability Target

For MVP, prioritize correctness and traceability over throughput. Performance optimization begins only after lifecycle correctness is demonstrated.
