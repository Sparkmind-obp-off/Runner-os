const sensitiveKey = /(authorization|password|passwd|secret|token|api[_-]?key|credential)/i

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(entry)
    }
    return output as T
  }
  return value
}
