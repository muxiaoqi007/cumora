import { pool } from '../db/pool.js'

export type ByoaLlmSource = 'byoa-claude' | 'byoa-codex' | 'byoa-pi'

export function isByoaLlmSource(value: unknown): value is ByoaLlmSource {
  return value === 'byoa-claude' || value === 'byoa-codex' || value === 'byoa-pi'
}

/**
 * Older daemons recorded the adapter's built-in small-model default even after
 * per-Agent `fastModel` became configurable. Correct only that recognizable
 * legacy guess. A different reported model is preserved because it can be a
 * deliberate `CUMORA_TRIAGE_MODEL` deployment override, which outranks the
 * per-Agent setting at execution time.
 */
export async function resolveByoaTriageModel(args: {
  source: ByoaLlmSource
  agentId: string
  companyId?: string | null
  reportedModel?: string | null
}): Promise<string | null> {
  const reported = args.reportedModel?.trim() || null
  const legacyGuess = args.source === 'byoa-claude' ? 'haiku' : 'gpt-5.4-mini'
  if (reported && reported !== legacyGuess) return reported
  if (!args.companyId) return reported

  try {
    const { rows } = await pool.query<{ fast_model: string | null }>(
      `SELECT fast_model
         FROM participants
        WHERE id = $1 AND company_id = $2 AND kind = 'agent' AND departed_at IS NULL
        LIMIT 1`,
      [args.agentId, args.companyId],
    )
    const configured = rows[0]?.fast_model?.trim() || null
    return configured || reported
  } catch {
    // Observability must never add a new failure mode to an agent turn.
    return reported
  }
}
