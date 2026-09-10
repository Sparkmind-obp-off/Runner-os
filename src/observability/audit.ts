import type { AuditEvent } from '../core/types'
import type { RunnerStore } from '../persistence/store'
import { redact, redactFreeText } from '../security/redaction'

export class AuditRecorder {
  constructor(
    private readonly store: RunnerStore,
    private readonly now: () => string,
    private readonly createId: () => string,
  ) {}

  async record(runId: string, eventType: string, actor: string, metadata: Record<string, unknown> = {}): Promise<AuditEvent> {
    const event: AuditEvent = {
      event_id: this.createId(),
      run_id: runId,
      timestamp: this.now(),
      event_type: eventType,
      actor: redactFreeText(actor) ?? 'unknown',
      metadata: redact(metadata),
    }
    await this.store.appendAudit(event)
    return event
  }
}
