import type { AuditEvent } from '../core/types'
import type { RunnerStore } from '../persistence/store'
import { redact } from '../security/redaction'

export class AuditRecorder {
  constructor(
    private readonly store: RunnerStore,
    private readonly now: () => string,
    private readonly createId: () => string,
  ) {}

  record(runId: string, eventType: string, actor: string, metadata: Record<string, unknown> = {}): AuditEvent {
    const event: AuditEvent = {
      event_id: this.createId(),
      run_id: runId,
      timestamp: this.now(),
      event_type: eventType,
      actor,
      metadata: redact(metadata),
    }
    this.store.appendAudit(event)
    return event
  }
}
