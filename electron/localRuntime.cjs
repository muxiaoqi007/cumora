/* eslint-env node */
/**
 * Desktop-managed BYOA runtime host.
 *
 * Cumora Desktop ships the dependency-free agent daemon and runs it through
 * Electron's Node mode. This module also owns LOCAL runtime introspection: the
 * renderer asks this process which runtimes are installed and, where a runtime
 * exposes a stable catalog API, which models are actually available under the
 * operator's current login.
 */
const { app, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONFIG_PATH = path.join(os.homedir(), '.cumora', 'computer.json')
const SUPPORTED_ENGINES = new Set(['claude', 'codex', 'pi'])
const MAX_LOG_LINES = 80
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000

let child = null
let quitting = false
let lastError = null
let recentLines = []

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

function pushLine(line) {
  const clean = stripAnsi(line).trim()
  if (!clean) return
  recentLines.push(clean)
  if (recentLines.length > MAX_LOG_LINES) recentLines.shift()
  if (/\b(error|fatal|failed|not paired|not found|usage limit|rate.?limit|auth)/i.test(clean)) lastError = clean
  console.log(`[local-runtime] ${clean}`)
}

function bundledCliPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'agent-cli', 'dist', 'cli.js')
  return path.join(__dirname, '..', 'agent-cli', 'dist', 'cli.js')
}

/** Pull the login-shell PATH so Dock-launched builds still see Homebrew/npm CLIs. */
function runtimeEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (process.platform === 'win32') return env
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const shellPath = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (shellPath) env.PATH = shellPath
  } catch { /* keep inherited PATH */ }
  return env
}

function resolveRuntimeBin(engine) {
  if (!SUPPORTED_ENGINES.has(engine)) return null
  const env = runtimeEnv()
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, engine + ext)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          // On Windows npm CLIs are normally .cmd wrappers; let cmd.exe launch
          // them. No user-controlled arguments are passed by discovery calls.
          return {
            command: process.platform === 'win32' ? engine : candidate,
            shell: process.platform === 'win32',
            env,
          }
        }
      } catch { /* keep scanning */ }
    }
  }
  return null
}

function pathBins() {
  return [...SUPPORTED_ENGINES].filter((engine) => !!resolveRuntimeBin(engine))
}

function pairedConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return {
      computerId: typeof raw.computerId === 'string' ? raw.computerId : null,
      serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : null,
    }
  } catch { return null }
}

function alive() {
  return !!child && child.exitCode == null && !child.killed
}

function status() {
  const paired = pairedConfig()
  return {
    supported: true,
    bundled: fs.existsSync(bundledCliPath()),
    running: alive(),
    paired: !!paired?.computerId,
    computerId: paired?.computerId ?? null,
    serverUrl: paired?.serverUrl ?? null,
    pid: alive() ? child.pid ?? null : null,
    engines: pathBins(),
    lastError,
    recentLines: recentLines.slice(-12),
  }
}

function stopOwnedChild() {
  if (!alive()) { child = null; return }
  try { child.kill('SIGTERM') } catch { /* already gone */ }
  child = null
}

function validateServerUrl(value) {
  if (value == null || String(value).trim() === '') return null
  const raw = String(value).trim().replace(/\/+$/, '')
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('Invalid Cumora server URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Cumora server URL must use http or https')
  return raw
}

function startOwnedDaemon(options = {}) {
  const cli = bundledCliPath()
  if (!fs.existsSync(cli)) throw new Error('The bundled local runtime host is missing. Reinstall or rebuild Cumora Desktop.')
  if (alive()) return child

  const argv = [cli, 'agent', 'computer']
  if (options.pairCode) {
    argv.push('--pair', String(options.pairCode))
    if (options.serverUrl) argv.push('--server', options.serverUrl)
    if (options.engine) argv.push('--engine', options.engine)
  }

  lastError = null
  recentLines = []
  const proc = spawn(process.execPath, argv, {
    env: runtimeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child = proc

  const pump = (buf) => { for (const line of buf.toString('utf8').split('\n')) pushLine(line) }
  proc.stdout?.on('data', pump)
  proc.stderr?.on('data', pump)
  proc.on('error', (err) => {
    lastError = err instanceof Error ? err.message : String(err)
    pushLine(`daemon spawn failed: ${lastError}`)
  })
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null
    if (!quitting && code !== 0) {
      const detail = recentLines.slice(-4).join(' · ')
      lastError = detail || `local runtime exited (${signal || code})`
    }
  })
  return proc
}

async function connectLocal(options) {
  const pairCode = typeof options?.pairCode === 'string' ? options.pairCode.trim() : ''
  if (!pairCode) throw new Error('Pairing code is required')
  const serverUrl = validateServerUrl(options?.serverUrl)
  const engine = typeof options?.engine === 'string' && SUPPORTED_ENGINES.has(options.engine) ? options.engine : null

  stopOwnedChild()
  const proc = startOwnedDaemon({ pairCode, serverUrl, engine })
  return await new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
      fn(value)
    }
    const inspect = (text) => {
      buffer = (buffer + text).slice(-12000)
      const match = buffer.match(/\[computer\]\s+paired as\s+([^\s]+).*?available:\s*([^\)]+)\)/i)
      if (match) {
        const engines = String(match[2] || '').split(',').map((s) => s.trim()).filter((x) => SUPPORTED_ENGINES.has(x))
        finish(resolve, { ok: true, computerId: match[1], engines })
      }
    }
    const onData = (buf) => inspect(buf.toString('utf8'))
    const onExit = (code, signal) => {
      const detail = recentLines.slice(-8).join('\n')
      finish(reject, new Error(detail || `Local runtime exited before pairing completed (${signal || code})`))
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', onExit)
    const timer = setTimeout(() => {
      const cfg = pairedConfig()
      if (cfg?.computerId && alive()) finish(resolve, { ok: true, computerId: cfg.computerId, engines: pathBins() })
      else finish(reject, new Error(lastError || 'Timed out while pairing this computer'))
    }, 20_000)
    timer.unref?.()
  })
}

// ─── Runtime model discovery ─────────────────────────────────────────────

function captureRuntime(engine, args, timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS) {
  const resolved = resolveRuntimeBin(engine)
  if (!resolved) return Promise.reject(new Error(`${engine} is not installed or is not visible on PATH`))
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const proc = spawn(resolved.command, args, {
      env: resolved.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: resolved.shell,
      windowsHide: true,
    })
    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err); else resolve(value)
    }
    proc.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
    proc.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
    proc.on('error', (err) => finish(err))
    proc.on('close', (code, signal) => {
      if (code === 0) finish(null, stripAnsi(stdout))
      else finish(new Error(stripAnsi(stderr).trim() || `${engine} exited ${signal || code}`))
    })
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM') } catch { /* already gone */ }
      finish(new Error(`${engine} model discovery timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
  })
}

function parsePiModels(output) {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const models = []
  const seen = new Set()
  for (const line of lines) {
    // pi prints: provider  model  context  max-out  thinking  images
    const cols = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean)
    if (cols.length < 2) continue
    const provider = cols[0]
    const rawModel = cols[1]
    if (/^provider$/i.test(provider) && /^model$/i.test(rawModel)) continue
    if (/^-+$/.test(provider) || /^=+$/.test(provider)) continue
    const id = rawModel.includes('/') ? rawModel : `${provider}/${rawModel}`
    if (seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      label: rawModel,
      provider,
      isDefault: false,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    })
  }
  return models
}

async function listPiModels() {
  const output = await captureRuntime('pi', ['--list-models'])
  const models = parsePiModels(output)
  if (models.length === 0) throw new Error('Pi returned no available models. Check `pi --list-models` and your provider credentials.')
  return { ok: true, engine: 'pi', source: 'pi-cli', models }
}

function listCodexModels() {
  const resolved = resolveRuntimeBin('codex')
  if (!resolved) return Promise.reject(new Error('codex is not installed or is not visible on PATH'))

  return new Promise((resolve, reject) => {
    let settled = false
    let outBuf = ''
    let stderr = ''
    let reqId = 1
    let modelReqId = null
    let pageCount = 0
    const models = []
    const seen = new Set()
    const proc = spawn(resolved.command, ['app-server', '--listen', 'stdio://'], {
      env: resolved.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: resolved.shell,
      windowsHide: true,
    })

    const finish = (err, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.stdin?.end() } catch { /* ignore */ }
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
      if (err) reject(err); else resolve(value)
    }
    const send = (msg) => {
      try { proc.stdin?.write(JSON.stringify(msg) + '\n') }
      catch (err) { finish(err instanceof Error ? err : new Error(String(err))) }
    }
    const requestPage = (cursor) => {
      pageCount += 1
      modelReqId = ++reqId
      send({ jsonrpc: '2.0', id: modelReqId, method: 'model/list', params: { limit: 100, cursor: cursor || null } })
    }
    const addModels = (data) => {
      if (!Array.isArray(data)) return
      for (const row of data) {
        if (!row || typeof row !== 'object') continue
        const id = typeof row.model === 'string' && row.model ? row.model : (typeof row.id === 'string' ? row.id : '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        const efforts = Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts.map((x) => x?.reasoningEffort).filter((x) => typeof x === 'string')
          : []
        models.push({
          id,
          label: typeof row.displayName === 'string' && row.displayName ? row.displayName : id,
          provider: 'OpenAI',
          isDefault: row.isDefault === true,
          reasoningEfforts: efforts,
          defaultReasoningEffort: typeof row.defaultReasoningEffort === 'string' ? row.defaultReasoningEffort : null,
        })
      }
    }

    proc.stdout?.on('data', (b) => {
      outBuf += b.toString('utf8')
      for (;;) {
        const nl = outBuf.indexOf('\n')
        if (nl < 0) break
        const line = outBuf.slice(0, nl).trim()
        outBuf = outBuf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg?.error?.message) {
          finish(new Error(`Codex app-server: ${String(msg.error.message)}`))
          return
        }
        if (msg?.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          requestPage(null)
          continue
        }
        if (modelReqId != null && msg?.id === modelReqId && msg.result) {
          addModels(msg.result.data)
          const cursor = typeof msg.result.nextCursor === 'string' ? msg.result.nextCursor : null
          if (cursor && pageCount < 8) requestPage(cursor)
          else {
            models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.label.localeCompare(b.label))
            if (models.length === 0) finish(new Error('Codex returned no available models for the current login.'))
            else finish(null, { ok: true, engine: 'codex', source: 'codex-app-server', models })
          }
        }
      }
    })
    proc.stderr?.on('data', (b) => { stderr = (stderr + b.toString('utf8')).slice(-4000) })
    proc.on('error', (err) => finish(err))
    proc.on('close', (code, signal) => {
      if (!settled) finish(new Error(stripAnsi(stderr).trim() || `Codex app-server exited ${signal || code} before model discovery completed`))
    })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'cumora-desktop', title: 'Cumora Desktop', version: '1.0.0' }, capabilities: { experimentalApi: true } },
    })

    const timer = setTimeout(() => finish(new Error('Codex model discovery timed out')), MODEL_DISCOVERY_TIMEOUT_MS)
    timer.unref?.()
  })
}

async function listLocalModels(engine) {
  if (!SUPPORTED_ENGINES.has(engine)) throw new Error(`Unsupported local runtime: ${engine}`)
  if (engine === 'pi') return listPiModels()
  if (engine === 'codex') return listCodexModels()
  // Claude Code currently accepts --model but does not expose an equivalent
  // stable local catalog command. Keep custom/manual input rather than shipping
  // a stale hardcoded list.
  return { ok: true, engine: 'claude', source: 'manual', models: [] }
}

ipcMain.handle('runtime:local-status', () => status())
ipcMain.handle('runtime:connect-local', async (_event, options) => {
  try { return await connectLocal(options) }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
})
ipcMain.handle('runtime:list-models', async (_event, engine) => {
  try { return await listLocalModels(String(engine || '')) }
  catch (err) { return { ok: false, engine: String(engine || ''), error: err instanceof Error ? err.message : String(err) } }
})
ipcMain.handle('runtime:stop-local', () => {
  stopOwnedChild()
  return status()
})

app.whenReady().then(() => {
  if (pairedConfig()?.computerId && !alive()) {
    try { startOwnedDaemon() }
    catch (err) { lastError = err instanceof Error ? err.message : String(err) }
  }
})

app.on('before-quit', () => {
  quitting = true
  stopOwnedChild()
})
