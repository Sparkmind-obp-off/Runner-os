import { readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createRunner } from '../src/engine/factory'
import { D1RunnerStore } from '../src/persistence/d1-runner-store'
import { deterministicOptions, task } from './helpers'

class LocalD1 {
  constructor(private readonly sqlite = new Database(':memory:')) {}
  async exec(sql: string) { this.sqlite.exec(sql); return { count: 1, duration: 0 } }
  prepare(sql: string) {
    const statement = this.sqlite.prepare(sql)
    let values: unknown[] = []
    const prepared = {
      bind: (...input: unknown[]) => { values = input; return prepared },
      run: async () => { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) }, results: [] } },
      first: async <T>() => statement.get(...values) as T | null,
      all: async <T>() => ({ success: true, meta: {}, results: statement.all(...values) as T[] }),
    }
    return prepared
  }
}

async function migratedDb(): Promise<D1Database> {
  const db = new LocalD1()
  const migration = await readFile('migrations/0001_runner_store.sql', 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  return db as unknown as D1Database
}

describe('D1RunnerStore durable persistence', () => {
  it('reproduces the schema and survives store/runtime re-instantiation', async () => {
    const db = await migratedDb()
    const firstStore = new D1RunnerStore(db)
    const firstRuntime = createRunner(deterministicOptions(), {}, firstStore)
    const input = task({ idempotency_key: 'durable-key' })
    const result = await firstRuntime.engine.execute(input)
    expect(result.status).toBe('completed')

    const freshStore = new D1RunnerStore(db)
    expect(await freshStore.getRun(result.run_id)).toMatchObject({ status: 'completed', task_id: input.task_id })
    expect(await freshStore.getSteps(result.run_id)).toMatchObject([{ status: 'succeeded', verification_status: 'PASS' }])
    expect((await freshStore.getEvidence(result.run_id)).map((item) => item.type)).toEqual(['execution', 'verification'])
    expect((await freshStore.getAudit(result.run_id)).some((event) => event.event_type === 'run.delivered')).toBe(true)
    expect(await freshStore.getIdempotentResult('durable-key')).toEqual(result)

    let secondId = 100
    const secondRuntime = createRunner(deterministicOptions({ createId: () => `restart-id-${++secondId}` }), {}, freshStore)
    expect(await secondRuntime.engine.execute({ ...input, task_id: 'duplicate-task' })).toEqual(result)
    expect(secondRuntime.mock.getExecutionCount()).toBe(0)
  })

  it('uses a database uniqueness constraint for concurrent claims', async () => {
    const db = await migratedDb()
    const storeA = new D1RunnerStore(db)
    const storeB = new D1RunnerStore(db)
    await storeA.saveRun({ run_id: 'run-a', task_id: 'unresolved', status: 'queued', started_at: '2026-09-10T00:00:00.000Z', attempt: 1 })
    await storeB.saveRun({ run_id: 'run-b', task_id: 'unresolved', status: 'queued', started_at: '2026-09-10T00:00:00.000Z', attempt: 1 })
    const claims = await Promise.all([storeA.claimIdempotency('same-key', 'run-a', '2026-09-10T00:00:00.000Z'), storeB.claimIdempotency('same-key', 'run-b', '2026-09-10T00:00:00.000Z')])
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)
  })
})
