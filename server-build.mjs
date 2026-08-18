// Bundle the Cumora server into a single standalone JS file for the
// packaged Electron app. In production the bundled CJS is loaded
// directly inside the Electron main process (no child process fork),
// so we export a `startServer` function rather than running main() at
// module load time.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgVersion = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')).version

const outfile = resolve(here, 'server', 'dist', 'index.cjs')

await build({
  entryPoints: [resolve(here, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  banner: { js: '#!/usr/bin/env node\n// Cumora server — bundled for local desktop mode' },
  legalComments: 'none',
  define: { __CUMORA_VERSION__: JSON.stringify(pkgVersion) },
  external: [],
  splitting: false,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  // Wrap the main() call in an exported function so the Electron main
  // process can call it on demand instead of it running at module load.
  footer: { js: '' },
})

console.log(`[server] bundled → ${outfile}`)