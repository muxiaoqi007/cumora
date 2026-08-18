import type { EngineId } from '@/types'

export type RuntimeModelDiscovery = 'manual' | 'local-catalog'

export interface RuntimeDefinition {
  id: EngineId
  label: string
  shortLabel: string
  description: string
  modelHint: string
  fastModelHint: string
  supportsFastModel: boolean
  /** How AgentEditor can populate the model picker for a desktop-local runtime. */
  modelDiscovery: RuntimeModelDiscovery
  /** Pi has no universal cheap model; an explicit small brain prevents accidental big-model triage. */
  requiresFastModel: boolean
}

/**
 * Presentation/capability metadata only. Runtime model IDs deliberately do NOT
 * live here: Codex and Pi publish their current catalogs locally, and Claude is
 * left as a custom model field until its CLI exposes an equivalent stable list.
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
    modelDiscovery: 'manual',
    requiresFastModel: false,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude',
    description: 'Local Claude Code CLI using the operator\'s existing login.',
    modelHint: 'Main Claude Code model. Leave blank to use the runtime default.',
    fastModelHint: 'Optional small/fast model for local triage and Claude auxiliary work; blank falls back to Haiku.',
    supportsFastModel: true,
    modelDiscovery: 'manual',
    requiresFastModel: false,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    shortLabel: 'Codex',
    description: 'Local Codex CLI using the operator\'s existing login.',
    modelHint: 'Choose from the models advertised by your current Codex login, or enter a custom model.',
    fastModelHint: 'Optional small model used for local triage; blank falls back to the Cumora Codex support-model default.',
    supportsFastModel: true,
    modelDiscovery: 'local-catalog',
    requiresFastModel: false,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    shortLabel: 'Pi',
    description: 'Local Pi coding-agent runtime with its configured providers and models.',
    modelHint: 'Choose a model from Pi\'s configured providers, or enter provider/model manually.',
    fastModelHint: 'Required: choose an explicitly cheap/small Pi model for inbox triage. Cumora will not silently use Pi\'s default main model here.',
    supportsFastModel: true,
    modelDiscovery: 'local-catalog',
    requiresFastModel: true,
  },
}

export function runtimeDefinition(id: EngineId): RuntimeDefinition {
  return RUNTIME_CATALOG[id] ?? RUNTIME_CATALOG.managed
}

export function runtimeLabel(id: EngineId): string {
  return runtimeDefinition(id).label
}
