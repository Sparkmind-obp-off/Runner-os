import { AdapterRegistry } from '../adapters/registry'
import { GitHubReadAdapter, type GitHubReadAdapterOptions } from '../adapters/github-read-adapter'
import { MockToolAdapter, type MockAdapterOptions } from '../adapters/mock-adapter'
import { RunnerEngine, type RunnerEngineOptions } from './runner'
import { InMemoryRunnerStore, type RunnerStore } from '../persistence/store'

export function createRunner(
  options: RunnerEngineOptions = {},
  mockOptions: MockAdapterOptions = {},
  store: RunnerStore = new InMemoryRunnerStore(),
  githubOptions: GitHubReadAdapterOptions = {},
) {
  const registry = new AdapterRegistry()
  const mock = new MockToolAdapter(mockOptions)
  const github = new GitHubReadAdapter(githubOptions)
  registry.register(mock)
  registry.register(github)
  const engine = new RunnerEngine(store, registry, options)
  return { engine, store, registry, mock, github }
}
