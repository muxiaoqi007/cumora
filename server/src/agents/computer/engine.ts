/**
 * Runtime registry for BYOA agents.
 *
 * The mature Claude Code / Codex implementations live unchanged in
 * `engine-core.ts`. This registry adds runtime-wide policy on top: additional
 * engines (Pi today) and per-agent small-brain model resolution shared by every
 * adapter.
 */
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as core from './engine-core.js'

export type EngineId = core.EngineId | 'pi'
export type EnginePersona = core.EnginePersona
export type EngineRunArgs = core.EngineRunArgs
export type EngineUsage = core.EngineUsage
export type EngineRunResult = core.EngineRunResult
export type EngineClassifyArgs = core.EngineClassifyArgs
export type EngineClassifyResult = core.EngineClassifyResult
export type EngineProbeArgs = core.EngineProbeArgs
export type EngineWakeProbeArgs = core.EngineWakeProbeArgs
export type EngineWakeProbeResult = core.EngineWakeProbeResult
export type EngineHopReport = core.EngineHopReport
export type EngineSessionArgs = core.EngineSessionArgs
export type EngineSession = core.EngineSession
export type BrainHealth = core.BrainHealth
export type WakeHealth = core.WakeHealth

export interface EngineAdapter {
  readonly id: EngineId
  readonly bin: string
  seedHome(home: string, persona: EnginePersona): Promise<void>
  run(args: EngineRunArgs): Promise<EngineRunResult>
  startSession?(args: EngineSessionArgs): EngineSession | null
  classify(args: EngineClassifyArgs): Promise<EngineClassifyResult>
  probe(args: EngineProbeArgs): Promise<EngineClassifyResult>
  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult>
}

export interface EngineHealth {
  id: EngineId
  installed: boolean
  path: string | null
  big: BrainHealth | null
  small: BrainHealth | null
  wake: WakeHealth | null
}

export const binOnPath = core.binOnPath
export const resolveBinPath = core.resolveBinPath
export const ENGINE_IDS: EngineId[] = [...core.ENGINE_IDS, 'pi']

const PI_SESSION_SENTINEL = 'pi-continue'
const MAX_FAILURE_LINES = 30
const MAX_FAILURE_CHARS = 4000
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const DEFAULT_COMPUTER_CONFIG_PATH = join(homedir(), '.cumora', 'computer.json')
const AGENT_CONFIG_CACHE_MS = 30_000

function cleanLine(line: string): string {
  return line.replace(ANSI_RE, '').replace(/\r/g, '').trim()
}

function pushTail(lines: string[], line: string): void {
  if (!line) return
  lines.push(line)
  if (lines.length > MAX_FAILURE_LINES) lines.shift()
}

function extraArgs(envVar: string): string[] {
  const raw = process.env[envVar]
  return raw ? raw.split(/\s+/).filter(Boolean) : []
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function ensurePiHome(home: string, persona: EnginePersona): Promise<void> {
  await mkdir(join(home, 'memory'), { recursive: true })
  await mkdir(join(home, 'notes'), { recursive: true })
  await mkdir(join(home, 'workspace'), { recursive: true })

  const memoryIndex = join(home, 'memory', 'MEMORY.md')
  if (!(await exists(memoryIndex))) {
    await writeFile(
      memoryIndex,
      '# Memory index\n\n' +
      'One line per durable fact, pointing at the file that holds it:\n' +
      '`- [Title](file.md) — one-line hook`\n\n' +
      'Write the fact itself in its own `memory/<topic>.md` file; keep this index short.\n',
      'utf8',
    )
  }

  const agentsMd = join(home, 'AGENTS.md')
  if (!(await exists(agentsMd))) {
    await writeFile(
      agentsMd,
      `# ${persona.name}${persona.role ? ` — ${persona.role}` : ''}\n\n` +
      `You are **${persona.name}**, a member of a team that collaborates in Cumora.\n` +
      'This directory is your private home and working directory. Stay inside it unless the operator explicitly asks otherwise.\n\n' +
      '## Durable state\n' +
      '- Read `memory/MEMORY.md` at the start of work that may depend on prior context.\n' +
      '- Put durable facts in `memory/<topic>.md` and index them from `memory/MEMORY.md`.\n' +
      '- Put scratch notes in `notes/` and project work in `workspace/`.\n\n' +
      '## Cumora\n' +
      'Use the `cumora` CLI already on PATH for team actions. Useful commands include:\n' +
      '- `cumora inbox`\n' +
      '- `cumora messages <conversationId> --tail 30`\n' +
      '- `cumora reply <conversationId> --file <path>`\n' +
      '- `cumora contacts [<query>]`\n' +
      '- `cumora whoami`\n\n' +
      'Never expose files, credentials, or paths outside this home through Cumora. Be a real teammate with your own voice.\n',
      'utf8',
    )
  }
}

type PiCaptureResult = { exitCode: number; text: string; error?: string }

function spawnPiCapture(args: string[], opts: {
  cwd: string
  env: NodeJS.ProcessEnv
  prompt?: string
  signal: AbortSignal
  onLog?: (line: string) => void
}): Promise<PiCaptureResult> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32'
    const child = spawn('pi', args, {
      cwd: opts.cwd,
      env: opts.env,
      shell,
      stdio: [opts.prompt != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
    if (opts.prompt != null) {
      try { child.stdin?.write(opts.prompt); child.stdin?.end() } catch { /* error handler below */ }
    }

    const stdout: string[] = []
    const stderr: string[] = []
    const onAbort = (): void => { child.kill('SIGTERM') }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (buf: Buffer) => {
      const raw = buf.toString('utf8')
      stdout.push(raw)
      for (const item of raw.split('\n')) {
        const line = cleanLine(item)
        if (line) opts.onLog?.(line)
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      for (const item of buf.toString('utf8').split('\n')) {
        const line = cleanLine(item)
        if (!line) continue
        pushTail(stderr, line)
        opts.onLog?.(line)
      }
    })
    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort)
      resolve({ exitCode: 1, text: '', error: err instanceof Error ? err.message : String(err) })
    })
    child.on('close', (code, signalName) => {
      opts.signal.removeEventListener('abort', onAbort)
      const exitCode = code ?? (signalName ? 128 : 1)
      const text = stdout.join('').replace(ANSI_RE, '').trim()
      const prefix = signalName ? `process terminated by ${signalName}` : `process exited with code ${exitCode}`
      const detail = stderr.join('\n').trim()
      resolve({
        exitCode,
        text,
        error: exitCode === 0 ? undefined : (detail ? `${prefix}\n${detail}` : prefix).slice(0, MAX_FAILURE_CHARS),
      })
    })
  })
}

type SyncedAgentRuntimeConfig = { id?: string; fastModel?: string | null }
type ComputerConfig = { serverUrl?: string; deviceToken?: string }

let agentConfigCache: { at: number; rows: SyncedAgentRuntimeConfig[] } | null = null
let agentConfigFetch: Promise<SyncedAgentRuntimeConfig[]> | null = null

function computerConfigPath(): string {
  return process.env.CUMORA_COMPUTER_CONFIG_PATH?.trim() || DEFAULT_COMPUTER_CONFIG_PATH
}

/**
 * Resolve the server-owned per-agent fast model without creating a second local
 * settings store. The daemon already authenticates this computer with a revocable
 * device token; the registry reuses that same read-only agent feed and caches it
 * briefly. This closes a legacy gap where daemon classify() only passed its global
 * override even though participants already carried `fastModel`.
 */
async function syncedFastModel(agentId: string | undefined): Promise<string | null> {
  if (!agentId) return null
  const now = Date.now()
  if (agentConfigCache && now - agentConfigCache.at < AGENT_CONFIG_CACHE_MS) {
    return agentConfigCache.rows.find((row) => row.id === agentId)?.fastModel?.trim() || null
  }

  if (!agentConfigFetch) {
    agentConfigFetch = (async () => {
      const raw = JSON.parse(await readFile(computerConfigPath(), 'utf8')) as ComputerConfig
      const serverUrl = raw.serverUrl?.replace(/\/+$/, '')
      const token = raw.deviceToken
      if (!serverUrl || !token) throw new Error('Cumora computer config is missing serverUrl/deviceToken')
      const res = await fetch(`${serverUrl}/api/computers/me/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`agent config sync HTTP ${res.status}`)
      const data = await res.json()
      const rows = Array.isArray(data) ? data as SyncedAgentRuntimeConfig[] : []
      agentConfigCache = { at: Date.now(), rows }
      return rows
    })().finally(() => { agentConfigFetch = null })
  }

  try {
    const rows = await agentConfigFetch
    return rows.find((row) => row.id === agentId)?.fastModel?.trim() || null
  } catch {
    // Transient sync failure: return null so the runtime uses its safe built-in
    // fallback (Claude/Codex) or fails closed rather than selecting a Pi main model.
    return null
  }
}

/** Global override > per-agent setting > adapter-specific safe default. */
async function classifyModel(args: EngineClassifyArgs): Promise<string | null> {
  const explicit = args.model?.trim()
  if (explicit) return explicit
  return syncedFastModel(args.env.CUMORA_AGENT_ID)
}

/** Wrap legacy core adapters so their classify() path also honors Agent.fastModel. */
class ConfiguredCoreAdapter implements EngineAdapter {
  readonly id: core.EngineId
  readonly bin: string
  constructor(private readonly base: core.EngineAdapter) {
    this.id = base.id
    this.bin = base.bin
  }
  seedHome(home: string, persona: EnginePersona): Promise<void> { return this.base.seedHome(home, persona) }
  run(args: EngineRunArgs): Promise<EngineRunResult> { return this.base.run(args) }
  startSession(args: EngineSessionArgs): EngineSession | null { return this.base.startSession?.(args) ?? null }
  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const model = await classifyModel(args)
    return this.base.classify({ ...args, model })
  }
  probe(args: EngineProbeArgs): Promise<EngineClassifyResult> { return this.base.probe(args) }
  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> { return this.base.probeWake(args) }
}

class PiAdapter implements EngineAdapter {
  readonly id = 'pi' as const
  readonly bin = 'pi'

  seedHome(home: string, persona: EnginePersona): Promise<void> { return ensurePiHome(home, persona) }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_PI_TRIAGE_ARGS')
    const fast = (await classifyModel(args)) || process.env.CUMORA_DEFAULT_PI_FAST_MODEL?.trim() || null
    // Pi can host arbitrary providers. Never guess that its default/main model is
    // cheap enough for triage: no explicit/global/per-agent small model = no call.
    if (!fast && flags.length === 0) {
      return {
        text: '',
        error: 'Pi local triage has no fast model configured. Choose this agent\'s Fast model in Cumora or set CUMORA_DEFAULT_PI_FAST_MODEL.',
      }
    }
    const base = flags.length
      ? ['-p', ...flags]
      : [
          '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
          '--no-prompt-templates', '--no-context-files', '--thinking', 'off', '--model', fast!,
        ]
    const r = await spawnPiCapture(base, {
      cwd: args.cwd,
      env: args.env,
      prompt: args.prompt,
      signal: args.signal,
      onLog: args.onLog,
    })
    return { text: r.text, error: r.error }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // Doctor is machine-level and has no Agent id, so small-brain health can only
    // probe the optional deployment fallback. Real per-agent settings are tested
    // by their actual triage calls.
    const fast = args.tier === 'small' ? process.env.CUMORA_DEFAULT_PI_FAST_MODEL?.trim() : null
    if (args.tier === 'small' && !fast) {
      return {
        text: '',
        error: 'No global Pi fast-model fallback is configured. Per-agent Fast models may still be healthy; set CUMORA_DEFAULT_PI_FAST_MODEL to make --doctor probe Pi small-brain globally.',
      }
    }
    const model = fast ? ['--model', fast] : []
    const r = await spawnPiCapture([
      '-p', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--thinking', 'off', ...model,
    ], {
      cwd: args.cwd,
      env: args.env,
      prompt: 'Connectivity check. Reply with exactly: OK',
      signal: args.signal,
    })
    return { text: r.text, error: r.error }
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_PI_ARGS')
    const model = args.model ? ['--model', args.model] : []
    const resume = args.resumeSessionId === PI_SESSION_SENTINEL ? ['--continue'] : []
    const argv = flags.length ? ['-p', ...resume, ...flags] : ['-p', '--approve', ...resume, ...model]
    const r = await spawnPiCapture(argv, {
      cwd: args.home,
      env: args.env,
      prompt: args.prompt,
      signal: args.signal,
      onLog: args.onLog,
    })
    return {
      exitCode: r.exitCode,
      error: r.error,
      sessionId: r.exitCode === 0 ? PI_SESSION_SENTINEL : (args.resumeSessionId ?? null),
      model: args.model ?? null,
    }
  }
}

const ADAPTERS: Record<EngineId, EngineAdapter> = {
  claude: new ConfiguredCoreAdapter(core.getAdapter('claude')),
  codex: new ConfiguredCoreAdapter(core.getAdapter('codex')),
  pi: new PiAdapter(),
}

export function getAdapter(id: EngineId): EngineAdapter { return ADAPTERS[id] }

export async function detectEngines(): Promise<EngineId[]> {
  const [base, pi] = await Promise.all([core.detectEngines(), core.binOnPath('pi')])
  return pi ? [...base, 'pi'] : [...base]
}

async function probePiTier(tier: 'big' | 'small', cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<BrainHealth> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()
  let result: EngineClassifyResult
  try { result = await ADAPTERS.pi.probe({ tier, cwd, env, signal: controller.signal }) }
  catch (err) { result = { text: '', error: err instanceof Error ? err.message : String(err) } }
  finally { clearTimeout(timer) }
  const ms = Date.now() - t0
  if (controller.signal.aborted) return { ok: false, ms, detail: `timed out after ${timeoutMs}ms` }
  if (result.error || !result.text.trim()) return { ok: false, ms, detail: cleanLine(result.error || 'no output').slice(0, 280) }
  return { ok: true, ms, detail: result.text.trim().slice(0, 80) }
}

export async function runEngineDoctor(opts?: {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onLog?: (line: string) => void
}): Promise<EngineHealth[]> {
  const env = opts?.env ?? process.env
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const basePromise = core.runEngineDoctor(opts) as Promise<EngineHealth[]>
  const path = await core.resolveBinPath('pi')
  if (!path) return basePromise

  opts?.onLog?.('probing pi big-brain…')
  const cwd = process.cwd()
  const big = await probePiTier('big', cwd, env, timeoutMs)
  opts?.onLog?.('probing pi small-brain…')
  const small = await probePiTier('small', cwd, env, timeoutMs)
  const base = await basePromise
  return [...base, {
    id: 'pi', installed: true, path, big, small,
    wake: { ok: true, ms: 0, detail: '', skipped: true },
  }]
}
