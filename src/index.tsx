import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createRunner } from './engine/factory'
import { D1RunnerStore } from './persistence/d1-runner-store'

interface Bindings { DB?: D1Database }
const app = new Hono<{ Bindings: Bindings }>()
const fallbackRuntime = createRunner()
const runtimeFor = (db?: D1Database) => db ? createRunner({}, {}, new D1RunnerStore(db)) : fallbackRuntime

app.use('/api/*', cors())

app.get('/', (c) => c.json({
  name: 'Runner OS',
  version: '0.3.0',
  phase: 'Phase 0 → Phase 3',
  flow: ['Task', 'Normalize', 'Validate', 'Plan', 'Policy Check', 'Approval Gate', 'Execute', 'Observe', 'Verify', 'Persist Evidence', 'Audit', 'Recover/Advance/Stop', 'Deliver Result'],
}))
app.get('/health', (c) => c.json({ status: 'ok' }))

app.post('/api/runs', async (c) => {
  let body: unknown
  try { body = await c.req.json() }
  catch { return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, 400) }
  const result = await runtimeFor(c.env?.DB).engine.execute(body)
  return c.json(result, result.status === 'completed' ? 200 : result.status === 'awaiting_approval' ? 202 : 422)
})

app.get('/api/runs/:runId', async (c) => {
  const runId = c.req.param('runId')
  const store = runtimeFor(c.env?.DB).store
  const run = await store.getRun(runId)
  if (!run) return c.json({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found.' } }, 404)
  return c.json({ run, steps: await store.getSteps(runId), evidence: await store.getEvidence(runId), audit: await store.getAudit(runId), approval: await store.getApproval(runId) })
})

app.post('/api/runs/:runId/approval', async (c) => {
  let body: { decision?: unknown; actor?: unknown; reason?: unknown }
  try { body = await c.req.json() }
  catch { return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, 400) }
  if ((body.decision !== 'approved' && body.decision !== 'rejected') || typeof body.actor !== 'string' || !body.actor.trim()) {
    return c.json({ error: { code: 'INVALID_APPROVAL', message: 'decision must be approved/rejected and actor is required.' } }, 400)
  }
  try {
    const result = await runtimeFor(c.env?.DB).engine.decideApproval(c.req.param('runId'), body.decision, body.actor.trim(), typeof body.reason === 'string' ? body.reason : undefined)
    return c.json(result, result.status === 'completed' ? 200 : result.status === 'awaiting_approval' ? 202 : 422)
  } catch (error) { return c.json({ error: { code: 'APPROVAL_ERROR', message: error instanceof Error ? error.message : 'Approval failed.' } }, 409) }
})

app.post('/api/runs/:runId/cancel', async (c) => {
  let body: { actor?: unknown } = {}
  try { body = await c.req.json() } catch { /* actor remains optional */ }
  const accepted = await runtimeFor(c.env?.DB).engine.cancel(c.req.param('runId'), typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'api')
  return c.json({ accepted }, accepted ? 202 : 409)
})

app.post('/api/runs/:runId/recover', async (c) => {
  try {
    const result = await runtimeFor(c.env?.DB).engine.recover(c.req.param('runId'), 'api-recovery')
    return c.json(result, result.status === 'completed' ? 200 : result.status === 'awaiting_approval' ? 202 : 422)
  } catch (error) { return c.json({ error: { code: 'RECOVERY_ERROR', message: error instanceof Error ? error.message : 'Recovery failed.' } }, 404) }
})

export default app
