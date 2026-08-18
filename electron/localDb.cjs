/* eslint-env node */
/**
 * Local PostgreSQL lifecycle manager for Cumora Desktop.
 *
 * Dedicated cluster under userData. First launch: initdb + createdb.
 * Later launches: start postgres against the existing data dir.
 */
const { app } = require('electron')
const { execFile, spawn } = require('node:child_process')
const { existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')
const net = require('node:net')

const execFileP = promisify(execFile)

const PG_PORT = 55432
const PG_DB = 'cumora'
const MAX_LOG_LINES = 40

function logFile() {
  return join(app.getPath('userData'), 'local-server.log')
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(logFile(), line) } catch { /* ignore */ }
  console.log(msg)
}

function pgBinDir() {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'postgresql', 'bin')
    if (existsSync(join(bundled, 'postgres'))) return bundled
  }
  const homebrewPaths = [
    '/opt/homebrew/opt/postgresql@16/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
    '/opt/homebrew/opt/postgresql@14/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/postgresql@16/bin',
    '/usr/local/opt/postgresql@17/bin',
    '/usr/local/opt/postgresql@15/bin',
    '/usr/local/opt/postgresql@14/bin',
    '/usr/local/bin',
  ]
  for (const p of homebrewPaths) {
    if (existsSync(join(p, 'postgres')) && existsSync(join(p, 'initdb'))) return p
  }
  return null
}

function pgBin(name) {
  const dir = pgBinDir()
  if (!dir) throw new Error('PostgreSQL not found. Install with: brew install postgresql@16')
  return join(dir, name)
}

function dataDir() {
  return join(app.getPath('userData'), 'postgres')
}

function socketDir() {
  const dir = join(app.getPath('userData'), 'postgres-run')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function databaseUrl() {
  return `postgres://cumora@127.0.0.1:${PG_PORT}/${PG_DB}`
}

let pgProcess = null
const recentLogs = []

function pushLog(line) {
  const clean = String(line || '').trim()
  if (!clean) return
  recentLogs.push(clean)
  if (recentLogs.length > MAX_LOG_LINES) recentLogs.shift()
  log(`[local-db] ${clean}`)
}

function isPortOpen() {
  return new Promise((resolve) => {
    const sock = net.connect({ port: PG_PORT, host: '127.0.0.1' })
    const done = (ok) => {
      sock.removeAllListeners()
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(400)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

function clearStalePid() {
  const pidFile = join(dataDir(), 'postmaster.pid')
  if (!existsSync(pidFile)) return
  let pid = 0
  try { pid = parseInt(readFileSync(pidFile, 'utf8').split('\n')[0], 10) } catch { pid = 0 }
  if (pid > 0) {
    try {
      process.kill(pid, 0)
      log(`[local-db] postgres pid ${pid} still alive`)
      return
    } catch {
      log(`[local-db] removing stale postmaster.pid (pid ${pid} is dead)`)
    }
  }
  try { unlinkSync(pidFile) } catch { /* ignore */ }
}

async function initdb() {
  const dir = dataDir()
  if (existsSync(join(dir, 'PG_VERSION'))) return
  log('[local-db] running initdb...')
  mkdirSync(dir, { recursive: true })
  await execFileP(pgBin('initdb'), [
    '-D', dir,
    '--auth=trust',
    '--username=cumora',
    '--encoding=UTF8',
  ])
  log('[local-db] initdb complete')
}

async function startServer() {
  if (await isPortOpen()) {
    log('[local-db] already listening on ' + PG_PORT)
    return
  }
  const dir = dataDir()
  if (!existsSync(join(dir, 'PG_VERSION'))) await initdb()
  clearStalePid()

  if (await isPortOpen()) {
    log('[local-db] already listening on ' + PG_PORT)
    return
  }

  const bin = pgBin('postgres')
  log(`[local-db] starting ${bin} on :${PG_PORT}`)
  recentLogs.length = 0

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    pgProcess = spawn(bin, [
      '-D', dir,
      '-p', String(PG_PORT),
      '-c', 'listen_addresses=127.0.0.1',
      '-c', `unix_socket_directories=${socketDir()}`,
      '-c', 'max_connections=20',
      '-c', 'shared_buffers=32MB',
      '-c', 'log_min_messages=info',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    pgProcess.stdout?.on('data', (b) => { for (const line of b.toString().split('\n')) pushLog(line) })
    pgProcess.stderr?.on('data', (b) => { for (const line of b.toString().split('\n')) pushLog(line) })
    pgProcess.on('error', (err) => finish(new Error(`failed to spawn postgres: ${err.message}`)))
    pgProcess.on('exit', (code, signal) => {
      pgProcess = null
      const detail = recentLogs.slice(-8).join('\n')
      finish(new Error(`postgres exited (${signal || code})${detail ? ':\n' + detail : ''}`))
    })

    let attempts = 0
    const check = async () => {
      if (settled) return
      attempts++
      if (await isPortOpen()) {
        log('[local-db] PostgreSQL is ready')
        finish(null)
        return
      }
      if (attempts > 80) {
        finish(new Error(
          'PostgreSQL did not become ready.\n' + (recentLogs.slice(-12).join('\n') || 'no postgres logs'),
        ))
        return
      }
      setTimeout(check, 250)
    }
    setTimeout(check, 200)
  })
}

async function createDatabase() {
  try {
    await execFileP(pgBin('createdb'), [
      '-p', String(PG_PORT), '-h', '127.0.0.1', '-U', 'cumora',
      '--maintenance-db=postgres',
      PG_DB,
    ])
    log('[local-db] created database "cumora"')
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e)
    if (!/already exists/i.test(msg)) log('[local-db] createDatabase: ' + msg)
  }
}

async function stop() {
  if (pgProcess) {
    try { pgProcess.kill('SIGTERM') } catch { /* already gone */ }
    pgProcess = null
    log('[local-db] PostgreSQL stopped')
    return
  }
  try {
    await execFileP(pgBin('pg_ctl'), ['stop', '-D', dataDir(), '-m', 'fast', '-w'])
    log('[local-db] PostgreSQL stopped via pg_ctl')
  } catch { /* not running */ }
}

async function ensure() {
  const dir = pgBinDir()
  if (!dir) throw new Error('PostgreSQL not found. Install with: brew install postgresql@16')
  log('[local-db] using binaries in ' + dir)
  await startServer()
  await createDatabase()
  return databaseUrl()
}

module.exports = { ensure, stop, databaseUrl, PG_PORT }
