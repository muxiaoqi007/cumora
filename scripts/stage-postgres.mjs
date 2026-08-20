#!/usr/bin/env node
/**
 * Copy embedded-postgres native binaries into vendor/postgresql for
 * electron-builder extraResources. Usage:
 *   node scripts/stage-postgres.mjs darwin-arm64
 *   node scripts/stage-postgres.mjs windows-x64
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const plat = process.argv[2] || `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const dest = join(root, 'vendor', 'postgresql')
const pkgName = `@embedded-postgres/${plat}`
let src = join(root, 'node_modules', '@embedded-postgres', plat, 'native')

if (!existsSync(join(src, 'bin'))) {
  console.log(`[stage-postgres] ${pkgName} not installed; packing from npm…`)
  const tmp = join(root, 'vendor', '.pg-tmp')
  mkdirSync(tmp, { recursive: true })
  execFileSync('npm', ['pack', `${pkgName}@18.4.0-beta.17`, '--pack-destination', tmp], { cwd: root, stdio: 'inherit' })
  const tgz = execFileSync('bash', ['-lc', `ls "${tmp}"/*.tgz | head -1`], { encoding: 'utf8' }).trim()
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' })
  src = join(tmp, 'package', 'native')
}

if (!existsSync(join(src, 'bin'))) {
  throw new Error(`[stage-postgres] native/bin missing in ${src}`)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
execFileSync('rsync', ['-aL', `${src}/`, `${dest}/`])
console.log(`[stage-postgres] staged ${plat} → vendor/postgresql`)
