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
  version: '0.2.0',
  phase: 'Phase 0 → Phase 2',
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
  const result = await runtimeFor(c.env?.DB).engine.execute(body)
  const status = result.status === 'completed' ? 200 : result.status === 'awaiting_approval' ? 202 : 422
  return c.json(result, status)
})

app.get('/api/runs/:runId', async (c) => {
  const runId = c.req.param('runId')
  const store = runtimeFor(c.env?.DB).store
  const run = await store.getRun(runId)
  if (!run) return c.json({ error: { code: 'RUN_NOT_FOUND', message: 'Run not found.' } }, 404)
  return c.json({
    run,
    steps: await store.getSteps(runId),
    evidence: await store.getEvidence(runId),
    audit: await store.getAudit(runId),
  })
})

export default app
