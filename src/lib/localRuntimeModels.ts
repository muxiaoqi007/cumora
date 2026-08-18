import type { EngineId } from '@/types'

export interface LocalRuntimeModel {
  /** Value passed to the runtime's --model / model field. */
  id: string
  /** Human-readable runtime-provided name. */
  label: string
  provider?: string | null
  isDefault?: boolean
  /** Runtime-advertised reasoning levels; informational until Runtime Options lands. */
  reasoningEfforts?: string[]
  defaultReasoningEffort?: string | null
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

/**
 * `src/lib/runtime.ts` describes the stable desktop bridge. Model discovery is
 * intentionally isolated here while Runtime 2.0 is being built so older desktop
 * shells (which do not expose `models`) remain source-compatible with the web UI.
 */
export function getLocalRuntimeModelBridge(): LocalRuntimeModelBridge | null {
  if (typeof window === 'undefined') return null
  const localRuntime = window.cumora?.localRuntime as unknown as Partial<LocalRuntimeModelBridge> | undefined
  return typeof localRuntime?.models === 'function' ? localRuntime as LocalRuntimeModelBridge : null
}
