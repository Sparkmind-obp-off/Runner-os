import { AdapterRegistry } from '../adapters/registry'
import { MockToolAdapter, type MockAdapterOptions } from '../adapters/mock-adapter'
import { RunnerEngine, type RunnerEngineOptions } from './runner'
import { InMemoryRunnerStore } from '../persistence/store'

export function createRunner(options: RunnerEngineOptions = {}, mockOptions: MockAdapterOptions = {}) {
  const store = new InMemoryRunnerStore()
  const registry = new AdapterRegistry()
  const mock = new MockToolAdapter(mockOptions)
  registry.register(mock)
  const engine = new RunnerEngine(store, registry, options)
  return { engine, store, registry, mock }
}
