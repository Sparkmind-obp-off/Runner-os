import type { SubmittedApprovalRecord, PolicyDecision, PolicyContext, RiskLevel, Step } from '../core/types'

export interface PolicyEvaluator {
  evaluate(step: Step, context: PolicyContext): PolicyDecision
}

export class DefaultPolicyEvaluator implements PolicyEvaluator {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  evaluate(step: Step, context: PolicyContext): PolicyDecision {
    const evaluated_at = this.now()
    if (context.denied_actions?.includes(step.action)) {
      return { decision: 'DENY', reason: `Action ${step.action} is explicitly denied.`, risk_level: step.risk_level, evaluated_at }
    }
    if (context.allowed_risk_levels && !context.allowed_risk_levels.includes(step.risk_level)) {
      return { decision: 'DENY', reason: `Risk level ${step.risk_level} is outside the allowed policy.`, risk_level: step.risk_level, evaluated_at }
    }
    if (step.risk_level <= 1) {
      return { decision: 'ALLOW', reason: `Risk level ${step.risk_level} may execute automatically.`, risk_level: step.risk_level, evaluated_at }
    }

    const approval = findApproval(context.approvals ?? [], step, evaluated_at)
    if (!approval) {
      return { decision: 'REQUIRE_APPROVAL', reason: `Risk level ${step.risk_level} requires explicit approval.`, risk_level: step.risk_level, evaluated_at }
    }
    if (approval.decision === 'REJECTED') {
      return { decision: 'DENY', reason: `Approval ${approval.approval_id} was rejected.`, risk_level: step.risk_level, evaluated_at }
    }
    return { decision: 'ALLOW', reason: `Approved by ${approval.approver}.`, risk_level: step.risk_level, evaluated_at }
  }
}

function findApproval(approvals: SubmittedApprovalRecord[], step: Step, now: string): SubmittedApprovalRecord | undefined {
  return approvals.find((approval) =>
    approval.requested_action === step.action
    && approval.risk_level === step.risk_level
    && (!approval.step_id || approval.step_id === step.step_id)
    && (!approval.run_id || approval.run_id === step.run_id)
    && (!approval.expires_at || approval.expires_at > now),
  )
}

export const riskLevels: ReadonlyArray<RiskLevel> = [0, 1, 2, 3]
