import type { RiskLevel, Task, TaskStepInput } from './types'

export class ContractValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Task validation failed: ${issues.join('; ')}`)
    this.name = 'ContractValidationError'
    this.issues = issues
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRiskLevel = (value: unknown): value is RiskLevel =>
  value === 0 || value === 1 || value === 2 || value === 3

export function normalizeTask(raw: unknown, now: string, createId: () => string): Task {
  if (!isRecord(raw)) throw new ContractValidationError(['task must be an object'])
  const rawInput = isRecord(raw.input) ? raw.input : {}
  const rawSteps = Array.isArray(rawInput.steps) ? rawInput.steps : []
  const steps: TaskStepInput[] = rawSteps.map((item) => {
    const step = isRecord(item) ? item : {}
    return {
      tool: typeof step.tool === 'string' ? step.tool.trim() : '',
      action: typeof step.action === 'string' ? step.action.trim() : '',
      input: isRecord(step.input) ? step.input : {},
      expected_outcome: isRecord(step.expected_outcome) ? step.expected_outcome : undefined,
      risk_level: isRiskLevel(step.risk_level) ? step.risk_level : 0,
    }
  })

  const taskRisk = isRiskLevel(raw.risk_level)
    ? raw.risk_level
    : steps.reduce<RiskLevel>((max, step) => Math.max(max, step.risk_level) as RiskLevel, 0)

  return {
    task_id: typeof raw.task_id === 'string' && raw.task_id.trim() ? raw.task_id.trim() : createId(),
    type: typeof raw.type === 'string' ? raw.type.trim() : typeof raw.task_type === 'string' ? raw.task_type.trim() : '',
    objective: typeof raw.objective === 'string' ? raw.objective.trim() : '',
    input: { steps },
    constraints: isRecord(raw.constraints) ? raw.constraints : {},
    risk_level: taskRisk,
    requested_at: typeof raw.requested_at === 'string' ? raw.requested_at : typeof raw.created_at === 'string' ? raw.created_at : now,
    requested_by: typeof raw.requested_by === 'string' ? raw.requested_by.trim() : '',
    policy_context: isRecord(raw.policy_context) ? raw.policy_context : {},
    idempotency_key: typeof raw.idempotency_key === 'string' ? raw.idempotency_key.trim() : '',
  }
}

export function validateTask(task: Task): void {
  const issues: string[] = []
  if (!task.task_id) issues.push('task_id is required')
  if (!task.type) issues.push('type is required')
  if (!task.objective) issues.push('objective is required')
  if (!task.requested_by) issues.push('requested_by is required')
  if (!task.idempotency_key) issues.push('idempotency_key is required')
  if (!task.input.steps.length) issues.push('at least one step is required')
  task.input.steps.forEach((step, index) => {
    if (!step.tool) issues.push(`steps[${index}].tool is required`)
    if (!step.action) issues.push(`steps[${index}].action is required`)
    if (!isRiskLevel(step.risk_level)) issues.push(`steps[${index}].risk_level is invalid`)
  })
  if (issues.length) throw new ContractValidationError(issues)
}
