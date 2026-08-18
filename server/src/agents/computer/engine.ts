/**
 * Runtime registry for BYOA agents.
 *
 * The mature Claude Code / Codex implementations live unchanged in
 * `engine-core.ts`. This registry adds runtime-wide policy on top: additional
 * engines (Pi today), per-agent small-brain model resolution, and server-owned
 * Runtime Options shared by every adapter.
 */
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
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
const RUNTIME_OPTIONS_CACHE_MS = 30_000
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

interface AgentRuntimeOptions {
  reasoningEffort?: string
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

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

/**
 * Cumora's generated agent bin directory is already first on PATH so the model
 * can call the `cumora` shim. Put a transparent Codex policy shim beside it:
 * it locates the REAL codex executable on the remainder of PATH, keeps the
 * original PATH for Codex/tool calls, and injects only the validated reasoning
 * override. Both `codex exec` and `codex app-server` therefore inherit the same
 * per-agent policy without editing the mature core adapter/session protocol.
 */
const CODEX_POLICY_SHIM = `#!/usr/bin/env node
'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const ownDir = path.resolve(__dirname)
const originalPath = String(process.env.PATH || '')
const dirs = originalPath.split(path.delimiter).filter(Boolean)
const exts = process.platform === 'win32'
  ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  : ['']
let real = null
for (const dir of dirs) {
  if (path.resolve(dir) === ownDir) continue
  for (const ext of exts) {
    const candidate = path.join(dir, 'codex' + ext)
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { real = candidate; break }
    } catch {}
  }
  if (real) break
}
if (!real) {
  console.error('cumora codex shim: real codex executable not found after agent bin directory')
  process.exit(127)
}
const args = process.argv.slice(2)
const effort = String(process.env.CUMORA_CODEX_REASONING_EFFORT || '').trim()
if (effort && /^[A-Za-z0-9._-]{1,40}$/.test(effort)) {
  args.unshift('-c', 'model_reasoning_effort="' + effort + '"')
}
const shell = /\\.(cmd|bat)$/i.test(real)
const child = spawn(real, args, { stdio: 'inherit', env: process.env, shell })
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { child.kill(sig) } catch {} })
}
child.on('error', (err) => { console.error('cumora codex shim:', err.message || err); process.exit(127) })
child.on('exit', (code, signal) => {
  if (signal) { try { process.kill(process.pid, signal) } catch { process.exit(128) } }
  else process.exit(typeof code === 'number' ? code : 1)
})
`

async function installCodexPolicyShim(home: string): Promise<void> {
  if (process.platform === 'win32') return
  const binDir = join(home, 'bin')
  const shim = join(binDir, 'codex')
  await mkdir(binDir, { recursive: true })
  await writeFile(shim, CODEX_POLICY_SHIM, 'utf8')
  await chmod(shim, 0o755)
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
const runtimeOptionsCache = new Map<string, { at: number; options: AgentRuntimeOptions }>()
const runtimeOptionsFetches = new Map<string, Promise<AgentRuntimeOptions>>()

function computerConfigPath(): string {
  return process.env.CUMORA_COMPUTER_CONFIG_PATH?.trim() || DEFAULT_COMPUTER_CONFIG_PATH
}

async function pairedComputerConfig(): Promise<{ serverUrl: string; deviceToken: string }> {
  const raw = JSON.parse(await readFile(computerConfigPath(), 'utf8')) as ComputerConfig
  const serverUrl = raw.serverUrl?.replace(/\/+$/, '')
  const deviceToken = raw.deviceToken
  if (!serverUrl || !deviceToken) throw new Error('Cumora computer config is missing serverUrl/deviceToken')
  return { serverUrl, deviceToken }
}

async function syncedFastModel(agentId: string | undefined): Promise<string | null> {
  if (!agentId) return null
  const now = Date.now()
  if (agentConfigCache && now - agentConfigCache.at < AGENT_CONFIG_CACHE_MS) {
    return agentConfigCache.rows.find((row) => row.id === agentId)?.fastModel?.trim() || null
  }

  if (!agentConfigFetch) {
    agentConfigFetch = (async () => {
      const { serverUrl, deviceToken } = await pairedComputerConfig()
      const res = await fetch(`${serverUrl}/api/computers/me/agents`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
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
    return null
  }
}

function normalizeRuntimeOptions(value: unknown): AgentRuntimeOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  const options: AgentRuntimeOptions = {}
  if (typeof raw.reasoningEffort === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw.reasoningEffort.trim())) {
    options.reasoningEffort = raw.reasoningEffort.trim()
  }
  if (typeof raw.thinkingLevel === 'string' && PI_THINKING_LEVELS.has(raw.thinkingLevel)) {
    options.thinkingLevel = raw.thinkingLevel as AgentRuntimeOptions['thinkingLevel']
  }
  return options
}

/** Server-owned Runtime Options, readable only for this paired computer's agents. */
async function syncedRuntimeOptions(agentId: string | undefined): Promise<AgentRuntimeOptions> {
  if (!agentId) return {}
  const cached = runtimeOptionsCache.get(agentId)
  if (cached && Date.now() - cached.at < RUNTIME_OPTIONS_CACHE_MS) return cached.options

  let inflight = runtimeOptionsFetches.get(agentId)
  if (!inflight) {
    inflight = (async () => {
      const { serverUrl, deviceToken } = await pairedComputerConfig()
      const res = await fetch(`${serverUrl}/api/agents/${encodeURIComponent(agentId)}/runtime-options`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      })
      if (!res.ok) throw new Error(`runtime options sync HTTP ${res.status}`)
      const data = await res.json() as { options?: unknown }
      const options = normalizeRuntimeOptions(data.options)
      runtimeOptionsCache.set(agentId, { at: Date.now(), options })
      return options
    })().finally(() => { runtimeOptionsFetches.delete(agentId) })
    runtimeOptionsFetches.set(agentId, inflight)
  }
  try { return await inflight }
  catch { return cached?.options ?? {} }
}

function cachedRuntimeOptions(agentId: string | undefined): AgentRuntimeOptions | null {
  if (!agentId) return {}
  const cached = runtimeOptionsCache.get(agentId)
  return cached && Date.now() - cached.at < RUNTIME_OPTIONS_CACHE_MS ? cached.options : null
}

function applyCoreRuntimeOptions(env: NodeJS.ProcessEnv, options: AgentRuntimeOptions): NodeJS.ProcessEnv {
  const next = { ...env }
  if (options.reasoningEffort) next.CUMORA_CODEX_REASONING_EFFORT = options.reasoningEffort
  else delete next.CUMORA_CODEX_REASONING_EFFORT
  return next
}

/** Global override > per-agent setting > adapter-specific safe default. */
async function classifyModel(args: EngineClassifyArgs): Promise<string | null> {
  const explicit = args.model?.trim()
  if (explicit) return explicit
  return syncedFastModel(args.env.CUMORA_AGENT_ID)
}

function runCodexOnWindowsWithEffort(
  base: core.EngineAdapter,
  args: EngineRunArgs,
  effort: string,
): Promise<EngineRunResult> {
  // Windows core resolves the .cmd shim from process.env rather than args.env,
  // and app-server is already disabled there. Inject the equivalent global CLI
  // `-c` only for the synchronous spawn setup, then restore immediately. No
  // await occurs while process.env is mutated, so another Agent cannot interleave.
  const previous = process.env.CUMORA_CODEX_ARGS
  const defaults = previous?.trim() || '--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check'
  process.env.CUMORA_CODEX_ARGS = `${defaults} -c model_reasoning_effort="${effort}"`
  try { return base.run(args) }
  finally {
    if (previous == null) delete process.env.CUMORA_CODEX_ARGS
    else process.env.CUMORA_CODEX_ARGS = previous
  }
}

/** Wrap legacy core adapters so classify/run/session paths honor Agent config. */
class ConfiguredCoreAdapter implements EngineAdapter {
  readonly id: core.EngineId
  readonly bin: string
  constructor(private readonly base: core.EngineAdapter) {
    this.id = base.id
    this.bin = base.bin
  }
  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await this.base.seedHome(home, persona)
    if (this.id === 'codex') await installCodexPolicyShim(home)
  }
  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const options = this.id === 'codex' ? await syncedRuntimeOptions(args.env.CUMORA_AGENT_ID) : {}
    const configured = { ...args, env: applyCoreRuntimeOptions(args.env, options) }
    if (this.id === 'codex' && process.platform === 'win32' && options.reasoningEffort) {
      return runCodexOnWindowsWithEffort(this.base, configured, options.reasoningEffort)
    }
    return this.base.run(configured)
  }
  startSession(args: EngineSessionArgs): EngineSession | null {
    if (this.id !== 'codex') return this.base.startSession?.(args) ?? null
    // startSession is intentionally synchronous. If this is the first agenda
    // wake and options have not been fetched yet, fall back to one-shot run();
    // that async path warms the cache and the next wake can use app-server.
    const options = cachedRuntimeOptions(args.env.CUMORA_AGENT_ID)
    if (options == null) return null
    return this.base.startSession?.({ ...args, env: applyCoreRuntimeOptions(args.env, options) }) ?? null
  }
  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const [model, options] = await Promise.all([
      classifyModel(args),
      this.id === 'codex' ? syncedRuntimeOptions(args.env.CUMORA_AGENT_ID) : Promise.resolve({}),
    ])
    // Do NOT force the main-brain reasoning override into triage CLI flags; the
    // small model owns its own cheap/default reasoning behavior. We only warm the
    // Runtime Options cache here so the subsequent app-server session is ready.
    return this.base.classify({ ...args, model, env: this.id === 'codex' ? args.env : applyCoreRuntimeOptions(args.env, options) })
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
    // Warm Runtime Options while triage is already doing server config reads.
    // The main Pi turn uses thinkingLevel; triage itself ALWAYS stays `off`.
    void syncedRuntimeOptions(args.env.CUMORA_AGENT_ID)
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
    const options = await syncedRuntimeOptions(args.env.CUMORA_AGENT_ID)
    const thinking = options.thinkingLevel ? ['--thinking', options.thinkingLevel] : []
    const argv = flags.length
      ? ['-p', ...resume, ...flags]
      : ['-p', '--approve', ...resume, ...model, ...thinking]
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
