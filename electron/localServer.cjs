/* eslint-env node */
/**
 * Local Cumora server — runs as a forked child process.
 *
 * Forks the bundled server CJS as a child process using Electron's Node.
 * The child runs independently; we poll /api/health until it's ready.
 */

const { app } = require('electron')
const { existsSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { fork } = require('node:child_process')
const http = require('node:http')

const SERVER_PORT = 5181
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_INTERVAL_MS = 500

let serverProcess = null
let started = false
let startError = null
let readyCallbacks = []

const LOG_FILE = join(app.getPath('userData'), 'local-server.log')
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
  console.log(msg)
}

function serverEntryPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'server', 'dist', 'index.cjs')
  }
  return join(__dirname, '..', 'server', 'dist', 'index.cjs')
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      `http://localhost:${SERVER_PORT}/api/health`,
      { timeout: 3000 },
      (res) => { resolve(res.statusCode === 200 || res.statusCode === 503); res.resume() },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

async function waitForReady() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkHealth()) return true
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS))
  }
  return false
}

async function start(databaseUrl, apiKey) {
  if (serverProcess) return true

  const entry = serverEntryPath()
  if (!existsSync(entry)) {
    throw new Error(`Server bundle not found: ${entry}`)
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CUMORA_LOCAL_MODE: 'true',
    CUMORA_REDIS_MODE: 'local',
    CUMORA_CORS_ORIGINS: '*',
    CUMORA_UPLOAD_DIR: join(app.getPath('userData'), 'uploads'),
    DATABASE_URL: databaseUrl,
    OPENAI_API_KEY: apiKey || 'local-mode-no-key',
    PORT: String(SERVER_PORT),
    NODE_ENV: 'development',
    ENABLE_SCANNER: 'false',
    ENABLE_IDLE: 'false',
    ENABLE_AGENT_POD_GC: 'false',
    ENABLE_CHROME_PVC_GC: 'false',
    ENABLE_CLUSTER_MONITOR: 'false',
  }

  log(`[local-server] forking server on :${SERVER_PORT} (db: ${databaseUrl})`)
  log(`[local-server] entry: ${entry}`)

  // Fork as child process. The bundled CJS auto-runs main() when executed
  // directly (require.main === module). IPC channel ('ipc') is required by fork.
  serverProcess = fork(entry, [], {
    execPath: process.execPath,
    execArgv: [],
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })

  serverProcess.stdout?.on('data', (b) => {
    const line = b.toString().trim()
    if (line) log(`[server] ${line}`)
  })
  serverProcess.stderr?.on('data', (b) => {
    const line = b.toString().trim()
    if (line) log(`[server:err] ${line}`)
  })
  serverProcess.on('exit', (code, signal) => {
    log(`[local-server] exited (code=${code}, signal=${signal})`)
    serverProcess = null
    started = false
  })
  serverProcess.on('error', (err) => {
    log(`[local-server] process error: ${err.message}`)
    startError = err.message
  })

  log(`[local-server] waiting for health...`)
  started = await waitForReady()
  if (started) {
    log(`[local-server] ready`)
    for (const cb of readyCallbacks) cb()
    readyCallbacks = []
  } else {
    startError = 'Server did not become healthy within 60s'
    log(`[local-server] ${startError}`)
    throw new Error(startError)
  }
  return started
}

function stop() {
  if (!serverProcess) { started = false; return }
  try { serverProcess.kill('SIGTERM'); log(`[local-server] sent SIGTERM`) } catch {}
  serverProcess = null
  started = false
}

function isReady() { return started }
function onReady(cb) { if (started) cb(); else readyCallbacks.push(cb) }
function getError() { return startError }

module.exports = { start, stop, isReady, onReady, getError, SERVER_PORT }
