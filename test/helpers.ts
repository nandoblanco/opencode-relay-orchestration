import type { Plugin } from '@opencode/plugin'
export function memoryStorage() {
  const data = new Map<string, unknown>()
  return { data, get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)) }, remove: async (key: string) => { data.delete(key) },
    scan: async ({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) => {
      const keys = [...data.keys()].sort().filter(key => key.startsWith(prefix) && (!after || key > after))
      const page = keys.slice(0, limit)
      return { entries: page.map(key => ({ key, value: structuredClone(data.get(key)) })), ...(keys.length > limit ? { next: page.at(-1) } : {}) }
    },
  } as unknown as Plugin.Context['storage'] & { data: Map<string, unknown> }
}
