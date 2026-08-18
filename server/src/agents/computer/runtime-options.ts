import { pool } from '../../db/pool.js'

export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number]

export interface AgentRuntimeOptions {
  /** Codex reasoning-effort override. Empty/absent = model/runtime default. */
  reasoningEffort?: string
  /** Pi main-brain thinking level. Triage stays forced to `off`. */
  thinkingLevel?: PiThinkingLevel
}

const PI_THINKING_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVELS)
const REASONING_EFFORT_RE = /^[A-Za-z0-9._-]{1,40}$/

/**
 * Keep runtime options deliberately narrow. Runtime-owned catalogs decide which
 * Codex efforts are offered by the UI; the server only enforces a safe scalar
 * shape so a newer Codex effort can be saved without a server redeploy.
 */
export function sanitizeRuntimeOptions(value: unknown): AgentRuntimeOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const out: AgentRuntimeOptions = {}

  if (typeof raw.reasoningEffort === 'string') {
    const effort = raw.reasoningEffort.trim()
    if (effort && REASONING_EFFORT_RE.test(effort)) out.reasoningEffort = effort
  }
  if (typeof raw.thinkingLevel === 'string' && PI_THINKING_SET.has(raw.thinkingLevel)) {
    out.thinkingLevel = raw.thinkingLevel as PiThinkingLevel
  }
  return out
}

/**
 * Kept outside the monolithic boot DDL so Runtime 2.0 can evolve independently.
 * Idempotent on every boot, same migration posture as the rest of Cumora.
 */
export async function ensureRuntimeOptionsSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runtime_options (
      agent_id   TEXT NOT NULL,
      company_id TEXT NOT NULL,
      options    JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, company_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runtime_options_company
      ON agent_runtime_options(company_id, updated_at DESC);
  `)
}

export async function getAgentRuntimeOptions(
  agentId: string,
  companyId: string,
): Promise<AgentRuntimeOptions> {
  const { rows } = await pool.query<{ options: unknown }>(
    `SELECT options FROM agent_runtime_options WHERE agent_id = $1 AND company_id = $2 LIMIT 1`,
    [agentId, companyId],
  )
  return sanitizeRuntimeOptions(rows[0]?.options)
}

export async function setAgentRuntimeOptions(
  agentId: string,
  companyId: string,
  value: unknown,
): Promise<AgentRuntimeOptions> {
  const options = sanitizeRuntimeOptions(value)
  await pool.query(
    `INSERT INTO agent_runtime_options (agent_id, company_id, options, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (agent_id, company_id)
     DO UPDATE SET options = EXCLUDED.options, updated_at = NOW()`,
    [agentId, companyId, JSON.stringify(options)],
  )
  return options
}
