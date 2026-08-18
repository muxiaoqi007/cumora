import type { EngineId } from '@/types'

export interface RuntimeDefinition {
  id: EngineId
  label: string
  shortLabel: string
  description: string
  modelHint: string
  fastModelHint: string
  supportsFastModel: boolean
}

/**
 * UI metadata for agent runtimes.
 *
 * Keep runtime presentation in one place instead of scattering
 * `engine === 'claude' ? ... : ...` branches through the product. Runtime
 * discovery still comes from the paired Computer (`availableEngines`); this
 * catalog only describes runtimes the current client knows how to present.
 *
 * Model IDs are deliberately NOT enumerated here. A runtime may add/remove
 * models independently of Cumora, so AgentEditor accepts the model identifier
 * reported/documented by that runtime and always allows a custom value.
 */
export const RUNTIME_CATALOG: Record<EngineId, RuntimeDefinition> = {
  managed: {
    id: 'managed',
    label: 'Cumora Cloud',
    shortLabel: 'Managed',
    description: 'Cumora-managed agent runtime.',
    modelHint: 'Optional model override. Leave blank to use the workspace default.',
    fastModelHint: 'Uses Cumora Cloud support-model defaults.',
    supportsFastModel: false,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    description: 'Local Claude Code CLI using the operator\'s existing login.',
    modelHint: 'Main Claude Code model. Leave blank to use the runtime default.',
    fastModelHint: 'Optional faster/cheaper model used by Claude Code for auxiliary work.',
    supportsFastModel: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    description: 'Local Codex CLI using the operator\'s existing login.',
    modelHint: 'Main Codex model. Leave blank to use the runtime default.',
    fastModelHint: 'Optional fast-model override for lightweight local decisions when supported.',
    supportsFastModel: true,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    shortLabel: 'Pi',
    description: 'Local Pi coding-agent runtime with its configured providers and models.',
    modelHint: 'Pi model ID or provider/model. Leave blank to use Pi\'s current default.',
    fastModelHint: 'Optional fast-model override for lightweight local decisions when supported.',
    supportsFastModel: true,
  },
}

export function runtimeDefinition(id: EngineId): RuntimeDefinition {
  return RUNTIME_CATALOG[id] ?? RUNTIME_CATALOG.managed
}

export function runtimeLabel(id: EngineId): string {
  return runtimeDefinition(id).label
}
