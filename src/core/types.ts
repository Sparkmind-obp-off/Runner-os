export type RiskLevel = 0 | 1 | 2 | 3
export type PolicyDecisionType = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'
export type VerificationStatus = 'PASS' | 'FAIL' | 'UNKNOWN'
export type Retryability = 'retryable' | 'non_retryable' | 'unknown'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type RecoveryOutcome = 'KNOWN_SUCCESS' | 'KNOWN_FAILURE' | 'UNKNOWN_REQUIRES_VERIFICATION' | 'RECOVERY_BLOCKED'

export type RunStatus =
  | 'queued' | 'validating' | 'planning' | 'awaiting_approval'
  | 'executing' | 'verifying' | 'completed' | 'failed'
  | 'cancelled' | 'blocked' | 'expired'

export type StepStatus =
  | 'pending' | 'validating' | 'executing' | 'verifying' | 'succeeded'
  | 'retryable_failure' | 'failed' | 'blocked' | 'skipped'

export type AdapterErrorCode =
  | 'VALIDATION_ERROR' | 'AUTH_ERROR' | 'RATE_LIMITED' | 'TIMEOUT'
  | 'TRANSIENT_PROVIDER_ERROR' | 'NOT_FOUND' | 'CONFLICT'
  | 'PERMISSION_DENIED' | 'UNKNOWN_PROVIDER_ERROR' | 'ADAPTER_UNAVAILABLE'

export interface ApprovalRecord {
  approval_id: string
  run_id: string
  step_id: string
  requested_action: string
  risk_level: RiskLevel
  status: ApprovalStatus
  requested_at: string
  decided_at?: string
  approver?: string
  reason?: string
  expires_at?: string
}

/** Legacy task-input approvals are normalized into durable records before use. */
export interface SubmittedApprovalRecord {
  approval_id: string
  run_id?: string
  step_id?: string
  requested_action: string
  risk_level: RiskLevel
  approver: string
  decision: 'APPROVED' | 'REJECTED'
  timestamp: string
  expires_at?: string
}

export interface PolicyContext {
  denied_actions?: string[]
  allowed_risk_levels?: RiskLevel[]
  approvals?: SubmittedApprovalRecord[]
}

export interface TaskStepInput {
  tool: string
  action: string
  input: Record<string, unknown>
  expected_outcome?: Record<string, unknown>
  risk_level: RiskLevel
}

export interface Task {
  task_id: string
  type: string
  objective: string
  input: { steps: TaskStepInput[] }
  constraints: Record<string, unknown>
  risk_level: RiskLevel
  requested_at: string
  requested_by: string
  policy_context: PolicyContext
  idempotency_key: string
}

export interface PolicyDecision {
  decision: PolicyDecisionType
  reason: string
  risk_level: RiskLevel
  evaluated_at: string
}

export interface VerificationResult {
  status: VerificationStatus
  summary: string
  details?: Record<string, unknown>
}

export interface RunnerError {
  code: string
  message: string
  retryability: Retryability
  step_id?: string
  attempt?: number
}

export interface AdapterExecutionResult {
  success: boolean
  provider: string
  operation: string
  provider_request_id?: string
  output?: Record<string, unknown>
  error?: RunnerError
  retryability: Retryability
  side_effect_reference?: string
}

export interface Run {
  run_id: string
  task_id: string
  status: RunStatus
  started_at: string
  finished_at?: string
  attempt: number
  policy_decision?: PolicyDecision
  result?: DeliveryResult
  error?: RunnerError
  cancellation_requested_at?: string
  cancellation_requested_by?: string
  recovery_outcome?: RecoveryOutcome
}

export interface Step {
  step_id: string
  run_id: string
  sequence: number
  tool: string
  action: string
  input: Record<string, unknown>
  expected_outcome?: Record<string, unknown>
  risk_level: RiskLevel
  status: StepStatus
  attempt: number
  idempotency_key: string
  started_at?: string
  finished_at?: string
  duration_ms?: number
  output?: Record<string, unknown>
  error?: RunnerError
  verification_status: VerificationStatus
  policy_decision?: PolicyDecision
  recovery_outcome?: RecoveryOutcome
}

export interface Evidence {
  evidence_id: string
  run_id: string
  step_id: string
  type: 'execution' | 'verification'
  source: string
  payload_reference: Record<string, unknown>
  captured_at: string
  integrity_hash: string
}

export interface AuditEvent {
  event_id: string
  run_id: string
  timestamp: string
  event_type: string
  actor: string
  metadata: Record<string, unknown>
}

export interface DeliveryResult {
  status: RunStatus
  run_id: string
  summary: string
  outputs: Array<{ step_id: string; output: Record<string, unknown> }>
  evidence: Evidence[]
  warnings: string[]
  errors: RunnerError[]
  next_action: string | null
}

export interface AdapterCapabilities {
  actions: string[]
  behavior: 'read' | 'write' | 'mixed'
  side_effect_level: RiskLevel
  authentication_required: boolean
  idempotency_supported: boolean
  verification_supported: boolean
  retry_safe: boolean
}

export interface ExecutionContext {
  run_id: string
  step_id: string
  idempotency_key: string
  attempt: number
  is_cancelled: () => boolean
}

export interface ToolAdapter {
  readonly name: string
  readonly version: string
  capabilities(): AdapterCapabilities
  validate(input: Record<string, unknown>, context: ExecutionContext): Promise<void>
  execute(input: Record<string, unknown>, context: ExecutionContext): Promise<AdapterExecutionResult>
  verify(result: AdapterExecutionResult, expected: Record<string, unknown> | undefined, context: ExecutionContext): Promise<VerificationResult>
}
