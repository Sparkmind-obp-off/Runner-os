import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { task } from './helpers'

describe('Cloudflare Pages API surface', () => {
  it('reports health and the implemented execution flow', async () => {
    const health = await app.request('/health')
    const root = await app.request('/')
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })
    expect(await root.json()).toMatchObject({ name: 'Runner OS', phase: 'Phase 0 → Phase 4' })
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

  it('persists approval decisions and resumes through the minimal API', async () => {
    const input = task({ risk_level: 2, idempotency_key: 'api-approval-key' })
    const submitted = await app.request('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    const pending = await submitted.json() as { run_id: string; status: string }
    expect(submitted.status).toBe(202)
    expect(pending.status).toBe('awaiting_approval')

    const approved = await app.request(`/api/runs/${pending.run_id}/approval`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved', actor: 'api-approver' }),
    })
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ status: 'completed' })

    const trace = await app.request(`/api/runs/${pending.run_id}`)
    expect(await trace.json()).toMatchObject({ approval: { status: 'approved', approver: 'api-approver' } })
  })

  it('persists cancellation and applies it through explicit recovery', async () => {
    const input = task({ risk_level: 2, idempotency_key: 'api-cancel-key' })
    const submitted = await app.request('/api/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    })
    const pending = await submitted.json() as { run_id: string }
    const cancelled = await app.request(`/api/runs/${pending.run_id}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'api-operator' }),
    })
    expect(cancelled.status).toBe(202)
    const recovered = await app.request(`/api/runs/${pending.run_id}/recover`, { method: 'POST' })
    expect(recovered.status).toBe(422)
    expect(await recovered.json()).toMatchObject({ status: 'cancelled' })
  })

  it('rejects malformed JSON', async () => {
    const response = await app.request('/api/runs', { method: 'POST', body: '{broken' })
    expect(response.status).toBe(400)
  })
})
