import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { task } from './helpers'

describe('Cloudflare Pages API surface', () => {
  it('reports health and the implemented execution flow', async () => {
    const health = await app.request('/health')
    const root = await app.request('/')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(await root.json()).toMatchObject({ name: 'Runner OS', phase: 'Phase 0 → Phase 2' })
  })

  it('executes a task and exposes its trace', async () => {
    const response = await app.request('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task()),
    })
    const result = await response.json() as { run_id: string; status: string }
    expect(response.status).toBe(200)
    expect(result.status).toBe('completed')

    const trace = await app.request(`/api/runs/${result.run_id}`)
    const body = await trace.json() as { steps: unknown[]; evidence: unknown[]; audit: unknown[] }
    expect(trace.status).toBe(200)
    expect(body.steps).toHaveLength(1)
    expect(body.evidence).toHaveLength(2)
    expect(body.audit.length).toBeGreaterThan(5)
  })

  it('rejects malformed JSON', async () => {
    const response = await app.request('/api/runs', { method: 'POST', body: '{broken' })
    expect(response.status).toBe(400)
  })
})
