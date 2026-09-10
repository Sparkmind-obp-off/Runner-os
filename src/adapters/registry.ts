import type { ToolAdapter } from '../core/types'

export class AdapterRegistry {
  private readonly adapters = new Map<string, ToolAdapter>()

  register(adapter: ToolAdapter): void {
    if (this.adapters.has(adapter.name)) throw new Error(`Adapter already registered: ${adapter.name}`)
    this.adapters.set(adapter.name, adapter)
  }

  resolve(name: string): ToolAdapter | undefined {
    return this.adapters.get(name)
  }
}
