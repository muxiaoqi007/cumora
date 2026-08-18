/**
 * Runtime registry for BYOA agents.
 *
 * The mature Claude Code / Codex implementations live unchanged in
 * `engine-core.ts`. This thin registry composes those adapters with additional
 * runtimes so adding a new engine no longer requires editing the large core
 * implementation. Pi is the first runtime added through this layer.
 */
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
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

/** Public adapter contract widened from the core's Claude/Codex-only EngineId. */
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

type PiCaptureResult = {
  exitCode: number
  text: string
  error?: string
}

/** Run Pi headlessly, sending user prompts through stdin. */
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

/** Resolve Pi's small-brain model. Never fall back to Pi's main/default model. */
function piFastModel(explicit?: string | null): string | null {
  return explicit?.trim()
    || process.env.CUMORA_DEFAULT_PI_FAST_MODEL?.trim()
    || null
}

/** Pi CLI adapter. */
class PiAdapter implements EngineAdapter {
  readonly id = 'pi' as const
  readonly bin = 'pi'

  seedHome(home: string, persona: EnginePersona): Promise<void> {
    return ensurePiHome(home, persona)
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_PI_TRIAGE_ARGS')
    const fast = piFastModel(args.model)
    // The most important invariant for Pi: triage must NEVER silently use the
    // runtime's main/default model. Pi can host arbitrary providers, so Cumora
    // cannot safely guess which model is cheap. Require an explicit per-agent
    // fast model (preferred) or the deployment-level fallback.
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
    const fast = args.tier === 'small' ? piFastModel(null) : null
    if (args.tier === 'small' && !fast) {
      return {
        text: '',
        error: 'Pi small-brain model is not configured. Set CUMORA_DEFAULT_PI_FAST_MODEL or configure a per-agent Fast model in Cumora.',
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
    const argv = flags.length
      ? ['-p', ...resume, ...flags]
      : ['-p', '--approve', ...resume, ...model]

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

const PI_ADAPTER = new PiAdapter()

export function getAdapter(id: EngineId): EngineAdapter {
  if (id === 'pi') return PI_ADAPTER
  return core.getAdapter(id as core.EngineId) as EngineAdapter
}

export async function detectEngines(): Promise<EngineId[]> {
  const [base, pi] = await Promise.all([
    core.detectEngines(),
    core.binOnPath('pi'),
  ])
  return pi ? [...base, 'pi'] : [...base]
}

async function probePiTier(tier: 'big' | 'small', cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<BrainHealth> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()
  let result: EngineClassifyResult
  try {
    result = await PI_ADAPTER.probe({ tier, cwd, env, signal: controller.signal })
  } catch (err) {
    result = { text: '', error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
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
    id: 'pi',
    installed: true,
    path,
    big,
    small,
    wake: { ok: true, ms: 0, detail: '', skipped: true },
  }]
}
