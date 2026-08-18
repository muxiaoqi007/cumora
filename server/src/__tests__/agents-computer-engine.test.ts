/**
 * Unit tests for BYOA local engine adapters.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine.test.ts
 */
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter } from '../agents/computer/engine.js'

const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_COMPUTER_CONFIG_PATH
  delete process.env.CUMORA_DEFAULT_PI_FAST_MODEL
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('local engine failure returns stderr tail for observability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: usage limit reached, no tokens left" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const result = await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /usage limit reached, no tokens left/i)
  assert.deepEqual(logs, ['Claude Code error: usage limit reached, no tokens left'])
})

test('persistent Claude startup failure keeps stderr for first send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-session-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: subscription expired" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const session = getAdapter('claude').startSession?.({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
  })

  assert.ok(session)
  await delay(50)
  const result = await session.send('wake')

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /subscription expired/i)
  assert.equal(logs[0], 'Claude Code error: subscription expired')
  assert.equal(logs.length, 2)
  assert.match(logs[1] ?? '', /\[session\] engine process died .*exit 1/)
})

test('Pi adapter passes the per-agent main model and continues its cwd-scoped session', async () => {
  if (process.platform === 'win32') return

  const root = await mkdtemp(join(tmpdir(), 'cumora-pi-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const argvLog = join(root, 'argv.log')
  const stdinLog = join(root, 'stdin.log')
  await mkdir(binDir)
  await mkdir(home)

  const fakePi = join(binDir, 'pi')
  await writeFile(
    fakePi,
    '#!/bin/sh\n' +
    `printf '%s\\n' "$*" >> "${argvLog}"\n` +
    `cat >> "${stdinLog}"\n` +
    'echo "pi-ok"\n',
    'utf8',
  )
  await chmod(fakePi, 0o755)

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
  const firstLogs: string[] = []
  const first = await getAdapter('pi').run({
    home,
    prompt: 'first wake',
    env,
    model: 'provider/model-x',
    fastModel: null,
    onLog: (line) => firstLogs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(first.exitCode, 0)
  assert.equal(first.sessionId, 'pi-continue')
  assert.equal(first.model, 'provider/model-x')
  assert.deepEqual(firstLogs, ['pi-ok'])

  const second = await getAdapter('pi').run({
    home,
    prompt: 'second wake',
    env,
    model: 'provider/model-x',
    fastModel: null,
    resumeSessionId: first.sessionId,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(second.exitCode, 0)

  const argvLines = (await readFile(argvLog, 'utf8')).trim().split('\n')
  assert.match(argvLines[0] ?? '', /-p --approve --model provider\/model-x/)
  assert.doesNotMatch(argvLines[0] ?? '', /--continue/)
  assert.match(argvLines[1] ?? '', /-p --approve --continue --model provider\/model-x/)
  const stdin = await readFile(stdinLog, 'utf8')
  assert.match(stdin, /first wake/)
  assert.match(stdin, /second wake/)
})

test('local triage resolves the current agent fastModel from the daemon config feed', async () => {
  if (process.platform === 'win32') return

  const root = await mkdtemp(join(tmpdir(), 'cumora-runtime-config-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const triageDir = join(root, 'triage')
  const argvLog = join(root, 'argv.log')
  const configPath = join(root, 'computer.json')
  await mkdir(binDir)
  await mkdir(triageDir)

  const fakePi = join(binDir, 'pi')
  await writeFile(
    fakePi,
    '#!/bin/sh\n' +
    `printf '%s\\n' "$*" >> "${argvLog}"\n` +
    'cat >/dev/null\n' +
    'echo "{\\"actionable\\":false}"\n',
    'utf8',
  )
  await chmod(fakePi, 0o755)

  let authHeader = ''
  const server = createServer((req, res) => {
    authHeader = String(req.headers.authorization ?? '')
    if (req.url === '/api/computers/me/agents') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([
        { id: 'agent-pi', fastModel: 'provider/tiny-model' },
        { id: 'agent-other', fastModel: 'provider/not-this-one' },
      ]))
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    await writeFile(configPath, JSON.stringify({
      serverUrl: `http://127.0.0.1:${address.port}`,
      deviceToken: 'device-test-token',
    }), 'utf8')
    process.env.CUMORA_COMPUTER_CONFIG_PATH = configPath

    const result = await getAdapter('pi').classify({
      cwd: triageDir,
      prompt: 'classify this',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        CUMORA_AGENT_ID: 'agent-pi',
      },
      model: null,
      signal: new AbortController().signal,
    })

    assert.equal(result.error, undefined)
    assert.match(result.text, /actionable/)
    assert.equal(authHeader, 'Bearer device-test-token')
    const argv = await readFile(argvLog, 'utf8')
    assert.match(argv, /--model provider\/tiny-model/)
    assert.match(argv, /--no-tools/)
    assert.match(argv, /--no-session/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('Pi triage fails closed at the adapter boundary when no cheap model is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-pi-no-fast-'))
  tempDirs.push(root)
  const triageDir = join(root, 'triage')
  await mkdir(triageDir)
  // No CUMORA_AGENT_ID and no deployment fallback: classify must not spawn Pi's
  // default/main model just to make a small-brain decision.
  const result = await getAdapter('pi').classify({
    cwd: triageDir,
    prompt: 'classify this',
    env: { ...process.env, CUMORA_AGENT_ID: '' },
    model: null,
    signal: new AbortController().signal,
  })
  assert.match(result.error ?? '', /no fast model configured/i)
})
