/* eslint-env node */
/**
 * Desktop-managed BYOA runtime host.
 *
 * The public `cumora` daemon is already a dependency-free Node bundle. The
 * desktop app ships that exact bundle and runs it with Electron's executable in
 * Node mode (`ELECTRON_RUN_AS_NODE=1`), so a normal desktop user never needs to
 * install Node, npm, or paste an `npx cumora agent computer ...` command.
 *
 * Lifecycle:
 *   - first connect: renderer gets an existing server pairing token and asks
 *     this bridge to pair; we wait for the daemon's real "paired as ..." line.
 *   - subsequent app launches: if ~/.cumora/computer.json exists, the daemon is
 *     started automatically and lives for the lifetime of Cumora Desktop.
 *   - app quit: only the child owned by this desktop process is terminated.
 *
 * The terminal/service path remains supported for VPS and web users.
 */
const { app, ipcMain } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CONFIG_PATH = path.join(os.homedir(), '.cumora', 'computer.json')
const SUPPORTED_ENGINES = new Set(['claude', 'codex', 'pi'])
const MAX_LOG_LINES = 80

let child = null
let quitting = false
let lastError = null
let recentLines = []

function pushLine(line) {
  const clean = String(line || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trim()
  if (!clean) return
  recentLines.push(clean)
  if (recentLines.length > MAX_LOG_LINES) recentLines.shift()
  if (/\b(error|fatal|failed|not paired|not found|usage limit|rate.?limit|auth)/i.test(clean)) lastError = clean
  console.log(`[local-runtime] ${clean}`)
}

function bundledCliPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'agent-cli', 'dist', 'cli.js')
  }
  return path.join(__dirname, '..', 'agent-cli', 'dist', 'cli.js')
}

/**
 * GUI apps on macOS/Linux often inherit a much smaller PATH than the user's
 * interactive shell. Pull the login-shell PATH once so binaries installed by
 * Homebrew/npm/pnpm/etc. remain discoverable when Cumora is launched from the
 * Dock rather than Terminal.
 */
function runtimeEnv() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (process.platform === 'win32') return env
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const shellPath = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (shellPath) env.PATH = shellPath
  } catch { /* keep the app's inherited PATH */ }
  return env
}

function pathBins() {
  const env = runtimeEnv()
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const found = []
  for (const engine of SUPPORTED_ENGINES) {
    let hit = false
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = path.join(dir, engine + ext)
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { hit = true; break }
        } catch { /* continue */ }
      }
      if (hit) break
    }
    if (hit) found.push(engine)
  }
  return found
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
  if (!fs.existsSync(cli)) {
    throw new Error('The bundled local runtime host is missing. Reinstall or rebuild Cumora Desktop.')
  }
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

  const pump = (buf) => {
    for (const line of buf.toString('utf8').split('\n')) pushLine(line)
  }
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
  const engine = typeof options?.engine === 'string' && SUPPORTED_ENGINES.has(options.engine)
    ? options.engine
    : null

  // A previous desktop-owned daemon may have auto-started from stale config.
  // Re-pairing is an explicit user action, so replace that child cleanly.
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
      if (cfg?.computerId && alive()) {
        finish(resolve, { ok: true, computerId: cfg.computerId, engines: pathBins() })
      } else {
        finish(reject, new Error(lastError || 'Timed out while pairing this computer'))
      }
    }, 20_000)
    timer.unref?.()
  })
}

ipcMain.handle('runtime:local-status', () => status())
ipcMain.handle('runtime:connect-local', async (_event, options) => {
  try { return await connectLocal(options) }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
})
ipcMain.handle('runtime:stop-local', () => {
  stopOwnedChild()
  return status()
})

app.whenReady().then(() => {
  // No pairing token is needed after the first successful connect: the daemon's
  // revocable device credential is already stored in ~/.cumora/computer.json.
  if (pairedConfig()?.computerId && !alive()) {
    try { startOwnedDaemon() }
    catch (err) { lastError = err instanceof Error ? err.message : String(err) }
  }
})

app.on('before-quit', () => {
  quitting = true
  stopOwnedChild()
})
