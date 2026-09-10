import type { Step, Task } from '../core/types'

export interface Planner {
  plan(task: Task, runId: string): Step[]
}

export class DeterministicPlanner implements Planner {
  plan(task: Task, runId: string): Step[] {
    return task.input.steps.map((definition, index) => ({
      step_id: `${runId}:step:${index + 1}`,
      run_id: runId,
      sequence: index + 1,
      tool: definition.tool,
      action: definition.action,
      input: structuredClone(definition.input),
      expected_outcome: definition.expected_outcome ? structuredClone(definition.expected_outcome) : undefined,
      risk_level: definition.risk_level,
      status: 'pending',
      attempt: 0,
      idempotency_key: `${runId}:step:${index + 1}:operation`,
      verification_status: 'UNKNOWN',
    }))
  }
}
