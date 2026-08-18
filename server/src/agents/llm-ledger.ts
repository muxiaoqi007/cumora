/**
 * Universal LLM call ledger.
 *
 * Cloud calls are recorded by tracked OpenAI clients; BYOA calls with provider
 * usage are mirrored by the paired daemon. Every row carries a business purpose,
 * tenant/agent scope, source runtime, model and cache-aware usage when available.
 * Recording is observability only and must never fail the underlying agent turn.
 */

import { randomUUID } from 'node:crypto'
import type OpenAI from 'openai'
import { pool } from '../db/pool.js'
import { getLlmClient } from '../llm.js'
import { effectiveCostUsd, priceFor, usageFromOpenAI, EMPTY_USAGE, type TokenUsage } from './cost.js'
import { resolveByoaTriageModel, type ByoaLlmSource } from './byoa-observability.js'

export type LlmCallPurpose =
  | 'agent-turn'
  | 'convene-speech'
  | 'inbox-triage'
  | 'synthetic-wake-gate'
  | 'agenda'
  | 'compaction'
  | 'completion-verify'
  | 'steer-summary'
  | 'convene-decision'
  | 'palette'
  | 'gender'
  | 'avatar-image'
  | 'agent-image'

export type LlmCallStatus = 'ok' | 'rate_limited' | 'timeout' | 'failed'
export type LlmCallSource = 'cloud' | ByoaLlmSource

export interface LlmCallContext {
  purpose: LlmCallPurpose
  companyId: string | null
  agentId?: string | null
  runId?: string | null
  conversationId?: string | null
  extras?: Record<string, unknown>
}

export interface LlmCallRecord extends LlmCallContext {
  source?: LlmCallSource
  model: string
  usage?: TokenUsage | null
  reasoningTokens?: number
  latencyMs: number
  status: LlmCallStatus
  error?: string | null
  daemonVersion?: string | null
}

/** Single INSERT into `llm_calls`. Never throws. */
export async function recordLlmCall(rec: LlmCallRecord): Promise<void> {
  const measured = !!rec.usage
  const usage = rec.usage ?? EMPTY_USAGE
  let model = rec.model
  // Old BYOA daemons may still report the adapter's historical small-model
  // default instead of the Agent's configured fastModel. Apply the same guarded
  // correction as agent_triages so both ledgers agree. A non-default reported
  // model is preserved as a deliberate global override.
  if (rec.purpose === 'inbox-triage' && rec.source && rec.source !== 'cloud' && rec.agentId) {
    model = (await resolveByoaTriageModel({
      source: rec.source,
      agentId: rec.agentId,
      companyId: rec.companyId,
      reportedModel: model,
    })) ?? model
  }
  const cost = effectiveCostUsd(model, usage)
  try {
    await pool.query(
      `INSERT INTO llm_calls (
         id, company_id, agent_id, run_id, conversation_id,
         purpose, source, model,
         input_tokens, cached_input_tokens, cache_creation_tokens,
         output_tokens, reasoning_tokens,
         cost_usd, cost_estimated, measured,
         latency_ms, status, error, extras, daemon_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)`,
      [
        `llm-${randomUUID()}`,
        rec.companyId, rec.agentId ?? null, rec.runId ?? null, rec.conversationId ?? null,
        rec.purpose, rec.source ?? 'cloud', model,
        usage.inputTokens, usage.cachedInputTokens, usage.cacheCreationTokens,
        usage.outputTokens, rec.reasoningTokens ?? 0,
        measured ? cost.usd : 0, cost.estimated, measured,
        rec.latencyMs, rec.status,
        rec.error ? rec.error.slice(0, 500) : null,
        rec.extras ? JSON.stringify(rec.extras) : null,
        rec.daemonVersion ?? null,
      ],
    )
  } catch (err) {
    console.warn('[llm-ledger] insert failed — dropping', err instanceof Error ? err.message : err)
  }
}

export function classifyLlmCallError(err: unknown): LlmCallStatus {
  const status = (err as { status?: number } | null)?.status
  const msg = err instanceof Error ? err.message : String(err)
  if (status === 429 || status === 503 || /rate.?limit|quota|too many requests|overload/i.test(msg)) return 'rate_limited'
  if ((err as { name?: string } | null)?.name === 'AbortError' || /timeout|aborted|ETIMEDOUT|deadline/i.test(msg)) return 'timeout'
  return 'failed'
}

export function readStreamUsage(ev: { type?: string } & Record<string, unknown>): TokenUsage | null {
  if (ev.type !== 'response.completed') return null
  const r = (ev as { response?: { usage?: unknown } }).response
  if (!r?.usage) return null
  return usageFromOpenAI(r.usage)
}

export function readStreamReasoningTokens(ev: { type?: string } & Record<string, unknown>): number {
  if (ev.type !== 'response.completed') return 0
  const r = (ev as { response?: { usage?: unknown } }).response
  return r?.usage ? readReasoningTokens(r.usage) : 0
}

function readReasoningTokens(usage: unknown): number {
  const u = (usage ?? {}) as { output_tokens_details?: { reasoning_tokens?: number } }
  const n = Number(u.output_tokens_details?.reasoning_tokens ?? 0)
  return Number.isFinite(n) ? n : 0
}

type AnyArgs = { model?: string; stream?: boolean; n?: number; size?: string } & Record<string, unknown>
type AnyResponse = { usage?: unknown } & Record<string, unknown>

export async function getTrackedLlmClient(ctx: LlmCallContext): Promise<OpenAI> {
  const raw = await getLlmClient(ctx.companyId)

  const wrapAwaited = (
    boundCreate: (args: AnyArgs, opts?: unknown) => Promise<AnyResponse>,
  ) =>
    async (args: AnyArgs, opts?: unknown): Promise<AnyResponse> => {
      const t0 = Date.now()
      const model = String(args.model ?? '<unknown>')
      if (args.stream === true) return await boundCreate(args, opts)
      try {
        const r = await boundCreate(args, opts)
        void recordLlmCall({
          ...ctx, model,
          usage: usageFromOpenAI(r.usage),
          reasoningTokens: readReasoningTokens(r.usage),
          latencyMs: Date.now() - t0, status: 'ok',
        })
        return r
      } catch (err) {
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0,
          status: classifyLlmCallError(err),
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

  const wrapImagesGenerate = (
    boundGenerate: (args: AnyArgs, opts?: unknown) => Promise<AnyResponse>,
  ) =>
    async (args: AnyArgs, opts?: unknown): Promise<AnyResponse> => {
      const t0 = Date.now()
      const model = String(args.model ?? '<unknown>')
      try {
        const r = await boundGenerate(args, opts)
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0, status: 'ok',
          extras: { ...(ctx.extras ?? {}), n: args.n ?? 1, size: args.size },
        })
        return r
      } catch (err) {
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0,
          status: classifyLlmCallError(err),
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

  return new Proxy(raw, {
    get(target, prop, receiver): unknown {
      if (prop === 'responses') {
        return new Proxy(target.responses as object, {
          get(rt: object, p: string | symbol, rr: unknown): unknown {
            if (p === 'create') {
              const create = (target.responses as { create: (...a: unknown[]) => Promise<unknown> }).create
              return wrapAwaited(create.bind(target.responses) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
            }
            return Reflect.get(rt, p, rr)
          },
        })
      }
      if (prop === 'chat') {
        return new Proxy(target.chat as object, {
          get(ct: object, p: string | symbol, cr: unknown): unknown {
            if (p === 'completions') {
              return new Proxy((target.chat as { completions: object }).completions, {
                get(cct: object, pp: string | symbol, ccr: unknown): unknown {
                  if (pp === 'create') {
                    const create = ((target.chat as { completions: { create: (...a: unknown[]) => Promise<unknown> } }).completions).create
                    return wrapAwaited(create.bind((target.chat as { completions: object }).completions) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
                  }
                  return Reflect.get(cct, pp, ccr)
                },
              })
            }
            return Reflect.get(ct, p, cr)
          },
        })
      }
      if (prop === 'images') {
        return new Proxy(target.images as object, {
          get(it: object, p: string | symbol, ir: unknown): unknown {
            if (p === 'generate') {
              const gen = (target.images as { generate: (...a: unknown[]) => Promise<unknown> }).generate
              return wrapImagesGenerate(gen.bind(target.images) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
            }
            return Reflect.get(it, p, ir)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export interface LlmSpendRollupRow {
  purpose: LlmCallPurpose
  model: string
  source: LlmCallSource
  calls: number
  okCalls: number
  failedCalls: number
  rateLimitedCalls: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  costEstimated: boolean
  savableUsd: number
}

export interface LlmSummary {
  sinceDays: number
  totalCalls: number
  totalCostUsd: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  failureRate: number
  rateLimitedCalls: number
  topPurpose: { purpose: LlmCallPurpose; costUsd: number } | null
  activeTenants: number
  cacheHitRate: number | null
  savableUsd: number
}

export interface LlmTrendBucket {
  day: string
  purpose: LlmCallPurpose
  costUsd: number
  calls: number
  inputTokens: number
  cachedInputTokens: number
}

export interface LlmTopAgentRow {
  agentId: string | null
  companyId: string | null
  agentName: string | null
  agentAvatarUrl: string | null
  agentAvatarBg: string | null
  agentInitial: string | null
  companyName: string | null
  costUsd: number
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export async function getLlmSpendRollup(args: {
  companyId?: string | null
  sinceDays?: number
  model?: string | null
}): Promise<LlmSpendRollupRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let where = `bucket_hour > NOW() - ($1::int * INTERVAL '1 day')`
  if (args.companyId !== undefined) {
    params.push(args.companyId)
    where += args.companyId === null ? ` AND company_id IS NULL` : ` AND company_id = $${params.length}`
  }
  if (args.model) {
    params.push(`%${args.model}%`)
    where += ` AND model ILIKE $${params.length}`
  }
  const { rows } = await pool.query<{
    purpose: string; model: string; source: string
    calls: string; ok_calls: string; failed_calls: string; rate_limited_calls: string
    input_tokens: string; cached_input_tokens: string; cache_creation_tokens: string
    output_tokens: string; reasoning_tokens: string
    cost_usd: string; cost_estimated: boolean
  }>(
    `SELECT
       purpose, model, source,
       SUM(calls)::text                                             AS calls,
       SUM(ok_calls)::text                                          AS ok_calls,
       SUM(failed_calls)::text                                      AS failed_calls,
       SUM(rate_limited_calls)::text                                AS rate_limited_calls,
       SUM(input_tokens)::text                                      AS input_tokens,
       SUM(cached_input_tokens)::text                               AS cached_input_tokens,
       SUM(cache_creation_tokens)::text                             AS cache_creation_tokens,
       SUM(output_tokens)::text                                     AS output_tokens,
       SUM(reasoning_tokens)::text                                  AS reasoning_tokens,
       COALESCE(SUM(cost_usd), 0)::text                             AS cost_usd,
       BOOL_OR(cost_estimated)                                      AS cost_estimated
     FROM llm_calls_rollup
     WHERE ${where}
     GROUP BY purpose, model, source
     ORDER BY SUM(cost_usd) DESC`,
    params,
  )
  return rows.map((r) => {
    const inputTokens = Number(r.input_tokens)
    const cachedInputTokens = Number(r.cached_input_tokens)
    const price = priceFor(r.model)
    const gap = Math.max(0, price.inPer1M - price.cachedInPer1M)
    const savableUsd = (inputTokens * gap) / 1_000_000
    return ({
      purpose: r.purpose as LlmCallPurpose,
      model: r.model,
      source: r.source as LlmCallSource,
      calls: Number(r.calls),
      okCalls: Number(r.ok_calls),
      failedCalls: Number(r.failed_calls),
      rateLimitedCalls: Number(r.rate_limited_calls),
      inputTokens,
      cachedInputTokens,
      cacheCreationTokens: Number(r.cache_creation_tokens),
      outputTokens: Number(r.output_tokens),
      reasoningTokens: Number(r.reasoning_tokens),
      costUsd: Number(r.cost_usd),
      costEstimated: r.cost_estimated,
      savableUsd,
    })
  })
}

export async function getLlmSummary(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<Omit<LlmSummary, 'topPurpose' | 'savableUsd'>> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  const where = `bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}`
  const { rows } = await pool.query<{
    is_total: number; company_id: string | null
    calls: string; cost_usd: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
    failed_calls: string; rate_limited_calls: string
  }>(
    `SELECT GROUPING(company_id)                AS is_total,
            company_id,
            SUM(calls)                          AS calls,
            COALESCE(SUM(cost_usd), 0)          AS cost_usd,
            SUM(input_tokens)                   AS input_tokens,
            SUM(cached_input_tokens)            AS cached_input_tokens,
            SUM(output_tokens)                  AS output_tokens,
            SUM(failed_calls)                   AS failed_calls,
            SUM(rate_limited_calls)             AS rate_limited_calls
       FROM llm_calls_rollup
      WHERE ${where}
      GROUP BY GROUPING SETS ((), (company_id))`,
    params,
  )
  const total = rows.find((r) => Number(r.is_total) === 1)
  const activeTenants = rows.reduce((n, r) => n + (Number(r.is_total) === 0 && r.company_id !== null ? 1 : 0), 0)
  const totalCalls = Number(total?.calls ?? 0)
  const failed = Number(total?.failed_calls ?? 0)
  const totalInputTokens = Number(total?.input_tokens ?? 0)
  const totalCachedInputTokens = Number(total?.cached_input_tokens ?? 0)
  const denom = totalInputTokens + totalCachedInputTokens
  const cacheHitRate = denom > 0 ? totalCachedInputTokens / denom : null
  return {
    sinceDays,
    totalCalls,
    totalCostUsd: Number(total?.cost_usd ?? 0),
    totalInputTokens,
    totalCachedInputTokens,
    totalOutputTokens: Number(total?.output_tokens ?? 0),
    failureRate: totalCalls > 0 ? failed / totalCalls : 0,
    rateLimitedCalls: Number(total?.rate_limited_calls ?? 0),
    activeTenants,
    cacheHitRate,
  }
}

export async function getLlmDailyTrend(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<LlmTrendBucket[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  const { rows } = await pool.query<{ day: string; purpose: string; cost_usd: string; calls: string; input_tokens: string; cached_input_tokens: string }>(
    `SELECT to_char(date_trunc('day', bucket_hour AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            purpose,
            COALESCE(SUM(cost_usd), 0)::text             AS cost_usd,
            SUM(calls)::text                             AS calls,
            SUM(input_tokens)::text                      AS input_tokens,
            SUM(cached_input_tokens)::text               AS cached_input_tokens
       FROM llm_calls_rollup
      WHERE bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
      GROUP BY day, purpose
      ORDER BY day ASC, cost_usd DESC`,
    params,
  )
  return rows.map((r) => ({
    day: r.day,
    purpose: r.purpose as LlmCallPurpose,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
  }))
}

export interface LlmTenantRow {
  companyId: string
  name: string | null
  slug: string | null
  costUsd: number
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export async function getLlmTenants(args: { sinceDays?: number; limit?: number } = {}): Promise<LlmTenantRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(500, args.limit ?? 100))
  const { rows } = await pool.query<{
    company_id: string; name: string | null; slug: string | null; cost_usd: string; calls: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
  }>(
    `SELECT l.company_id,
            c.name, c.slug,
            COALESCE(SUM(l.cost_usd), 0)::text             AS cost_usd,
            SUM(l.calls)::text                             AS calls,
            SUM(l.input_tokens)::text                      AS input_tokens,
            SUM(l.cached_input_tokens)::text               AS cached_input_tokens,
            SUM(l.output_tokens)::text                     AS output_tokens
       FROM llm_calls_rollup l
       LEFT JOIN companies c ON c.id = l.company_id
      WHERE l.bucket_hour > NOW() - ($1::int * INTERVAL '1 day')
        AND l.company_id IS NOT NULL
      GROUP BY l.company_id, c.name, c.slug
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST
      LIMIT $2`,
    [sinceDays, limit],
  )
  return rows.map((r) => ({
    companyId: r.company_id,
    name: r.name,
    slug: r.slug,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
  }))
}

export async function getLlmTopAgents(args: { sinceDays?: number; limit?: number; companyId?: string | null } = {}): Promise<LlmTopAgentRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(200, args.limit ?? 20))
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND l.company_id IS NULL`
    else { params.push(args.companyId); scope = `AND l.company_id = $${params.length}` }
  }
  params.push(limit)
  const { rows } = await pool.query<{
    agent_id: string | null; company_id: string | null; agent_name: string | null
    agent_avatar_url: string | null; agent_avatar_bg: string | null; agent_initial: string | null
    company_name: string | null
    cost_usd: string; calls: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
  }>(
    `SELECT l.agent_id, l.company_id,
            p.name AS agent_name,
            p.avatar_url AS agent_avatar_url,
            p.avatar_bg  AS agent_avatar_bg,
            p.initial    AS agent_initial,
            c.name       AS company_name,
            COALESCE(SUM(l.cost_usd), 0)::text          AS cost_usd,
            SUM(l.calls)::text                          AS calls,
            SUM(l.input_tokens)::text                   AS input_tokens,
            SUM(l.cached_input_tokens)::text            AS cached_input_tokens,
            SUM(l.output_tokens)::text                  AS output_tokens
       FROM llm_calls_rollup l
       LEFT JOIN participants p
              ON p.id = l.agent_id
             AND (p.company_id = l.company_id OR (p.company_id IS NULL AND l.company_id IS NULL))
       LEFT JOIN companies c ON c.id = l.company_id
      WHERE l.bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
      GROUP BY l.agent_id, l.company_id, p.name, p.avatar_url, p.avatar_bg, p.initial, c.name
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({
    agentId: r.agent_id,
    companyId: r.company_id,
    agentName: r.agent_name,
    agentAvatarUrl: r.agent_avatar_url,
    agentAvatarBg: r.agent_avatar_bg,
    agentInitial: r.agent_initial,
    companyName: r.company_name,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
  }))
}

export interface LlmCallRow {
  id: string
  createdAt: string
  companyId: string | null
  agentId: string | null
  agentName: string | null
  runId: string | null
  conversationId: string | null
  purpose: LlmCallPurpose
  source: LlmCallSource
  model: string
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  costEstimated: boolean
  measured: boolean
  latencyMs: number | null
  status: LlmCallStatus
  error: string | null
  extras: Record<string, unknown> | null
  daemonVersion: string | null
}

export async function getLlmCalls(args: {
  sinceDays?: number
  companyId?: string | null
  purpose?: LlmCallPurpose
  model?: string | null
  source?: LlmCallSource | null
  runId?: string | null
  agentId?: string | null
  limit?: number
  sortBy?: 'cost' | 'latency' | 'hop' | 'created'
}): Promise<LlmCallRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(200, args.limit ?? 50))
  const params: unknown[] = [sinceDays]
  const where: string[] = [`l.created_at > NOW() - ($1::int * INTERVAL '1 day')`]
  const add = (clause: string, value: unknown): void => {
    params.push(value)
    where.push(clause.replace('$$', `$${params.length}`))
  }
  if (args.purpose) add(`l.purpose = $$`, args.purpose)
  if (args.model) add(`l.model = $$`, args.model)
  if (args.source) add(`l.source = $$`, args.source)
  if (args.runId) add(`l.run_id = $$`, args.runId)
  if (args.agentId) add(`l.agent_id = $$`, args.agentId)
  if (args.companyId !== undefined) {
    if (args.companyId === null) where.push(`l.company_id IS NULL`)
    else add(`l.company_id = $$`, args.companyId)
  }
  const defaultSort: NonNullable<typeof args.sortBy> = (args.runId || args.agentId) ? 'created' : 'cost'
  const sortBy = args.sortBy ?? defaultSort
  const orderBy =
    sortBy === 'cost' ? 'l.cost_usd DESC NULLS LAST'
    : sortBy === 'latency' ? 'l.latency_ms DESC NULLS LAST'
    : sortBy === 'hop' ? `(l.extras->>'hopIndex')::int ASC NULLS LAST, l.created_at ASC`
    : 'l.created_at ASC'
  params.push(limit)
  const { rows } = await pool.query<{
    id: string; created_at: string; company_id: string | null
    agent_id: string | null; agent_name: string | null
    run_id: string | null; conversation_id: string | null
    purpose: string; source: string; model: string
    input_tokens: string; cached_input_tokens: string; cache_creation_tokens: string
    output_tokens: string; reasoning_tokens: string
    cost_usd: string; cost_estimated: boolean; measured: boolean
    latency_ms: number | null; status: string; error: string | null
    extras: Record<string, unknown> | null
    daemon_version: string | null
  }>(
    `SELECT
       l.id, l.created_at::text, l.company_id,
       l.agent_id, p.name AS agent_name,
       l.run_id, l.conversation_id,
       l.purpose, l.source, l.model,
       l.input_tokens::text, l.cached_input_tokens::text, l.cache_creation_tokens::text,
       l.output_tokens::text, l.reasoning_tokens::text,
       l.cost_usd::text, l.cost_estimated, l.measured,
       l.latency_ms, l.status, l.error,
       l.extras, l.daemon_version
     FROM llm_calls l
     LEFT JOIN participants p
            ON p.id = l.agent_id
           AND (p.company_id = l.company_id OR (p.company_id IS NULL AND l.company_id IS NULL))
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    companyId: r.company_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    runId: r.run_id,
    conversationId: r.conversation_id,
    purpose: r.purpose as LlmCallPurpose,
    source: r.source as LlmCallSource,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    cacheCreationTokens: Number(r.cache_creation_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
    measured: r.measured,
    latencyMs: r.latency_ms,
    status: r.status as LlmCallStatus,
    error: r.error,
    extras: r.extras,
    daemonVersion: r.daemon_version,
  }))
}

export interface LlmDaemonVersionRow {
  daemonVersion: string
  source: LlmCallSource
  calls: number
  costUsd: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  failureRate: number
  firstSeen: string
  lastSeen: string
}

export async function getLlmDaemonVersionRollup(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<LlmDaemonVersionRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  const { rows } = await pool.query<{
    daemon_version: string; source: string
    calls: string; cost_usd: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
    ok_calls: string
    first_seen: string; last_seen: string
  }>(
    `SELECT daemon_version, source,
            SUM(calls)::text                                               AS calls,
            COALESCE(SUM(cost_usd), 0)::text                               AS cost_usd,
            SUM(input_tokens)::text                                        AS input_tokens,
            SUM(cached_input_tokens)::text                                 AS cached_input_tokens,
            SUM(output_tokens)::text                                       AS output_tokens,
            SUM(ok_calls)::text                                            AS ok_calls,
            MIN(bucket_hour)::text                                         AS first_seen,
            MAX(bucket_hour)::text                                         AS last_seen
       FROM llm_calls_rollup
      WHERE bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
        AND daemon_version IS NOT NULL
      GROUP BY daemon_version, source
      ORDER BY MAX(bucket_hour) DESC, SUM(cost_usd) DESC`,
    params,
  )
  return rows.map((r) => {
    const calls = Number(r.calls)
    const failed = calls - Number(r.ok_calls)
    return {
      daemonVersion: r.daemon_version,
      source: r.source as LlmCallSource,
      calls,
      costUsd: Number(r.cost_usd),
      inputTokens: Number(r.input_tokens),
      cachedInputTokens: Number(r.cached_input_tokens),
      outputTokens: Number(r.output_tokens),
      failureRate: calls > 0 ? failed / calls : 0,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }
  })
}
