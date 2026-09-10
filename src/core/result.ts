import type { DeliveryResult, Evidence, Run, RunnerError, Step } from './types'

export function createDeliveryResult(run: Run, steps: Step[], evidence: Evidence[], errors: RunnerError[], warnings: string[] = []): DeliveryResult {
  const succeeded = steps.filter((step) => step.status === 'succeeded')
  const summary = run.status === 'completed'
    ? `Completed ${succeeded.length}/${steps.length} verified step(s).`
    : run.status === 'blocked'
      ? 'Execution blocked by policy.'
      : run.status === 'cancelled'
        ? 'Execution cancelled.'
        : `Execution failed after ${succeeded.length}/${steps.length} verified step(s).`

  return {
    status: run.status,
    run_id: run.run_id,
    summary,
    outputs: succeeded.filter((step) => step.output).map((step) => ({ step_id: step.step_id, output: step.output! })),
    evidence: [...evidence],
    warnings: [...warnings],
    errors: [...errors],
    next_action: run.status === 'awaiting_approval' ? 'Provide a valid approval record.' : null,
  }
}
