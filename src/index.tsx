import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createRunner } from './engine/factory'

const app = new Hono()
const runtime = createRunner()

app.use('/api/*', cors())

app.get('/', (c) => c.json({
  name: 'Runner OS',
  version: '0.1.0',
  phase: 'Phase 0 → Phase 1',
  flow: ['Task', 'Normalize', 'Validate', 'Plan', 'Policy Check', 'Execute', 'Observe', 'Verify', 'Persist Evidence', 'Audit', 'Deliver Result'],
}))

app.get('/health', (c) => c.json({ status: 'ok' }))

app.post('/api/runs', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, 400)
  }
  const result = await runtime.engine.execute(body)
  const status = result.status === 'completed' ? 200 : result.status === 'awaiting_approval' ? 202 : 422
  return c.json(result, status)
})

app.get('/api/runs/:runId', (c) => {
  const runId = c.req.param('runId')
  const run = runtime.store.getRun(runId)
  if (!run) return c.json({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found.' } }, 404)
  return c.json({
    run,
    steps: runtime.store.getSteps(runId),
    evidence: runtime.store.getEvidence(runId),
    audit: runtime.store.getAudit(runId),
  })
})

export default app
