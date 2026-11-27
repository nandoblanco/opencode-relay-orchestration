export const roles = ['planner', 'builder', 'reviewer', 'explorer'] as const
export type Role = typeof roles[number]
export type ModelRef = { providerID: string; id: string; variant?: string }
export type ProbeResult = { status: 'verified' | 'failed' | 'error'; sessionID: string; answer: string; tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; at: string }
export type RoleCheck = { role: Role; model?: ModelRef; exists: boolean; enabled: boolean; variant: boolean; tools: boolean; image: 'not configured' | 'not required' | 'unavailable' | 'declared' | 'verified' | 'failed' | 'error'; errors: string[]; probe?: ProbeResult }
export type SavedConfig = { version: 1; roles?: Partial<Record<Role, ModelRef>>; limits?: { maxFixCycles?: number; maxRunningTasks?: number }; widths?: number[]; autoStart?: boolean; explorer?: boolean; brainstormFirst?: boolean; updatedAt: string }
export type ConfigReport = { roles: RoleCheck[]; errors: string[]; limits: { maxRunningTasks: number; maxFixCycles: number }; enableProbe: boolean; widths?: number[]; autoStart?: boolean; explorer?: boolean; brainstormFirst?: boolean; source?: string; summary?: string }
export function effectiveConfig(options: unknown, saved?: SavedConfig) {
  const parsed = parseConfig(options)
  const models = { ...parsed.models, ...saved?.roles }
  const explorer = saved?.explorer ?? parsed.explorer ?? true
  if (!explorer) delete models.explorer
  return { ...parsed, models, limits: { ...parsed.limits, ...saved?.limits }, widths: saved?.widths ?? parsed.widths ?? [1280, 390], autoStart: saved?.autoStart ?? parsed.autoStart ?? true, explorer, brainstormFirst: saved?.brainstormFirst ?? parsed.brainstormFirst ?? true, source: saved ? `saved ${saved.updatedAt}` : 'options' }
}
export type EffectiveConfig = ReturnType<typeof effectiveConfig>
export function configSummary(config: Pick<EffectiveConfig, 'source' | 'limits' | 'widths' | 'autoStart' | 'explorer' | 'brainstormFirst'>) {
  return `Relay config: ${config.source}; fixes ${config.limits.maxFixCycles}; widths ${config.widths.join(', ')}; auto-start ${config.autoStart ? 'on' : 'off'}; parallel ${config.limits.maxRunningTasks}; explorer ${config.explorer ? 'on' : 'off'}; brainstorm ${config.brainstormFirst ? 'on' : 'off'}`
}
export type Candidate = { providerID: string; id: string; name: string; status: string; context: number; variants: string[]; tools: boolean; input: string[] }
export function candidates(models: { providerID: string; id: string; name: string; status: string; enabled?: boolean; capabilities: { tools: boolean; input: readonly string[] }; limit: { context: number }; variants: readonly { id: string }[] }[], role: Role): Candidate[] {
  return models.filter(model => model.enabled !== false && model.capabilities.tools && model.status !== 'deprecated' && (role !== 'reviewer' || model.capabilities.input.includes('image'))).map(model => ({ providerID: model.providerID, id: model.id, name: model.name, status: model.status, context: model.limit.context, variants: model.variants.map(variant => variant.id), tools: model.capabilities.tools, input: [...model.capabilities.input] }))
}
export type ConfigInput = Omit<SavedConfig, 'version' | 'updatedAt'>
export function validateSettings(input: ConfigInput, models: Parameters<typeof candidates>[0]) {
  for (const role of Object.keys(input.roles ?? {})) {
    if (!roles.includes(role as Role)) throw Error(`Unknown role: ${role}`)
    const ref = input.roles![role as Role]!
    const available = candidates(models, role as Role)
    const found = available.find(model => model.providerID === ref.providerID && model.id === ref.id)
    if (!found) {
      const near = available.filter(model => model.providerID === ref.providerID || model.id.includes(ref.id.split('-')[0])).slice(0, 3)
      throw Error(`Model ${ref.providerID}/${ref.id} is unavailable for ${role}. Nearby candidates: ${near.map(model => `${model.providerID}/${model.id}`).join(', ') || 'none'}. Use a listed model with tools${role === 'reviewer' ? ' and image input' : ''}.`)
    }
    if (ref.variant && !found.variants.includes(ref.variant)) throw Error(`Unknown variant ${ref.variant} for ${ref.id}. Available: ${found.variants.join(', ') || 'none'}.`)
  }
  if (input.limits?.maxFixCycles !== undefined && (!Number.isInteger(input.limits.maxFixCycles) || input.limits.maxFixCycles < 0 || input.limits.maxFixCycles > 5)) throw Error('maxFixCycles must be an integer from 0 to 5.')
  if (input.limits?.maxRunningTasks !== undefined && (!Number.isInteger(input.limits.maxRunningTasks) || input.limits.maxRunningTasks < 1 || input.limits.maxRunningTasks > 4)) throw Error('maxRunningTasks must be an integer from 1 to 4.')
  if (input.widths !== undefined && (!Array.isArray(input.widths) || input.widths.length < 1 || input.widths.length > 4 || input.widths.some(width => !Number.isInteger(width) || width < 320 || width > 3840))) throw Error('widths must contain 1 to 4 integer widths from 320 to 3840.')
  for (const field of ['autoStart', 'explorer', 'brainstormFirst'] as const) if (input[field] !== undefined && typeof input[field] !== 'boolean') throw Error(`${field} must be a boolean.`)
}
export function readLimits(limits: { maxRunningTasks?: unknown; maxFixCycles?: unknown } = {}) {
  return {
    maxRunningTasks: Number.isSafeInteger(limits.maxRunningTasks) && Number(limits.maxRunningTasks) > 0 ? Number(limits.maxRunningTasks) : 1,
    maxFixCycles: Number.isSafeInteger(limits.maxFixCycles) && Number(limits.maxFixCycles) >= 0 ? Number(limits.maxFixCycles) : 2,
  }
}
export function parseConfig(raw: unknown) {
  const errors: string[] = []; const models: Partial<Record<Role, ModelRef>> = {}
  const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) errors.push('options must be an object')
  const configured = options.roles
  if (configured !== undefined && (!configured || typeof configured !== 'object' || Array.isArray(configured))) errors.push('roles must be an object')
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) for (const key of Object.keys(configured)) if (!roles.includes(key as Role)) errors.push(`roles.${key} is not a supported role`)
  if (configured && typeof configured === 'object' && !Array.isArray(configured)) for (const role of roles) {
    const value = (configured as Record<string, unknown>)[role]
    if (value === undefined) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`roles.${role} must be an object`); continue }
    const model = value as Record<string, unknown>; const before = errors.length
    for (const key of ['providerID', 'id']) if (typeof model[key] !== 'string' || !model[key].trim()) errors.push(`roles.${role}.${key} must be a nonempty string`)
    if (model.variant !== undefined && (typeof model.variant !== 'string' || !model.variant.trim())) errors.push(`roles.${role}.variant must be a nonempty string`)
    if (before === errors.length) models[role] = { providerID: (model.providerID as string).trim(), id: (model.id as string).trim(), ...(model.variant !== undefined ? { variant: (model.variant as string).trim() } : {}) }
  }
  const limits = options.limits
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits))) errors.push('limits must be an object')
  const values = limits && typeof limits === 'object' && !Array.isArray(limits) ? limits as Record<string, unknown> : {}
  if (values.maxRunningTasks !== undefined && (!Number.isSafeInteger(values.maxRunningTasks) || Number(values.maxRunningTasks) < 1)) errors.push('limits.maxRunningTasks must be a positive integer; using 1')
  if (values.maxFixCycles !== undefined && (!Number.isSafeInteger(values.maxFixCycles) || Number(values.maxFixCycles) < 0)) errors.push('limits.maxFixCycles must be a nonnegative integer; using 2')
  if (options.enableProbe !== undefined && typeof options.enableProbe !== 'boolean') errors.push('enableProbe must be a boolean')
  let widths: number[] | undefined
  if (options.widths !== undefined) {
    if (!Array.isArray(options.widths) || options.widths.length < 1 || options.widths.length > 4 || options.widths.some(width => !Number.isInteger(width) || width < 320 || width > 3840)) errors.push('widths must contain 1 to 4 integer widths from 320 to 3840')
    else widths = options.widths
  }
  for (const field of ['autoStart', 'explorer', 'brainstormFirst']) if (options[field] !== undefined && typeof options[field] !== 'boolean') errors.push(`${field} must be a boolean`)
  return { models, errors, limits: readLimits(values), enableProbe: options.enableProbe === true, widths, autoStart: typeof options.autoStart === 'boolean' ? options.autoStart : undefined, explorer: typeof options.explorer === 'boolean' ? options.explorer : undefined, brainstormFirst: typeof options.brainstormFirst === 'boolean' ? options.brainstormFirst : undefined }
}
export function probeKey(model: ModelRef) { return `relay/image-probes/${encodeURIComponent(JSON.stringify([model.providerID, model.id, model.variant ?? '']))}` }
