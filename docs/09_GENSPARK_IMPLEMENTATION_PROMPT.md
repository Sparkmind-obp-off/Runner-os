# Runner OS — Genspark Implementation Prompt

## Mission

Implement the Runner OS MVP in this repository according to the documents in `docs/`.

Do not redesign the product direction. Do not replace the execution architecture with a provider-specific automation flow.

## Source of Truth

Read in this order:

1. `README.md`
2. `docs/01_RUNNER_OS_MASTER_BLUEPRINT.md`
3. `docs/02_PRODUCT_REQUIREMENTS.md`
4. `docs/03_DOMAIN_MODEL.md`
5. `docs/04_TOOL_ADAPTER_CONTRACT.md`
6. `docs/05_POLICY_SECURITY_MODEL.md`
7. `docs/06_EXECUTION_ENGINE_SPEC.md`
8. `docs/07_MVP_IMPLEMENTATION_PLAN.md`
9. `docs/08_TESTING_AND_ACCEPTANCE.md`

## Implementation Rules

- Inspect the repository before creating files.
- Use the existing project conventions if implementation files already exist.
- If the repo is still documentation-only, choose a minimal production-sensible stack and document the choice.
- Keep the core runner provider-independent.
- Implement the mock adapter first.
- Prefer small modules with explicit interfaces.
- Do not add unnecessary UI.
- Do not add dozens of integrations.
- Do not hard-code credentials or secrets.
- Do not silently weaken policy or verification to make tests pass.

## Required MVP

Implement:

- task/run/step/evidence models;
- run state machine;
- sequential execution engine;
- tool adapter contract;
- mock adapter;
- policy evaluator;
- idempotency handling;
- retry classification and bounded retry;
- verification interface;
- audit event interface;
- structured delivery result;
- automated tests for the mandatory scenarios.

Persistence may begin in-memory if Phase 1 is being implemented, but interfaces must allow a persistent implementation later.

## Definition of Done

The implementation is complete for the current phase only when:

1. tests pass;
2. a sample task can be executed end-to-end;
3. the result includes verification and evidence;
4. failure and retry behavior is visible;
5. policy-blocked actions do not execute;
6. idempotency prevents duplicate execution;
7. README explains how to run the project;
8. no secrets are committed;
9. implementation changes are summarized in a concise changelog/commit message.

## Final Output

After implementation, report:

- files created/changed;
- architecture decisions;
- commands used to test;
- test result;
- known limitations;
- exact next recommended phase.

Then stop. Do not start unrelated features.
