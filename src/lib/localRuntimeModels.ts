import type { EngineId } from '@/types'

export interface LocalRuntimeModel {
  /** Value passed to the runtime's --model / model field. */
  id: string
  /** Human-readable runtime-provided name. */
  label: string
  provider?: string | null
  isDefault?: boolean
  /** Codex runtime-advertised reasoning levels for this exact model. */
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string | null
  /** Pi's catalog-level `thinking=yes` capability for this exact model. */
  supportsThinking?: boolean
}

export type LocalRuntimeModelSource = 'codex-app-server' | 'pi-cli' | 'manual'

export type LocalRuntimeModelResult =
  | {
      ok: true
      engine: Exclude<EngineId, 'managed'>
      source: LocalRuntimeModelSource
      models: LocalRuntimeModel[]
    }
  | {
      ok: false
      engine: string
      error: string
    }

export interface LocalRuntimeModelBridge {
  models: (engine: Exclude<EngineId, 'managed'>) => Promise<LocalRuntimeModelResult>
}

/** Optional so a newer web bundle still works inside an older desktop shell. */
export function getLocalRuntimeModelBridge(): LocalRuntimeModelBridge | null {
  if (typeof window === 'undefined') return null
  const models = window.cumora?.localRuntime?.models
  return typeof models === 'function' ? { models } : null
}
