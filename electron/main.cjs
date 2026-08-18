/* eslint-env node */
// Keep the mature Electron shell in main-core.cjs. Local Runtime 2.0 is a
// separate lifecycle/IPC module so the BYOA desktop integration can evolve
// without turning the already-large window/update/auth entrypoint into another
// runtime switchboard.

// Local/desktop mode: the app runs its own bundled server + database.
// This flag is read by localRuntime.cjs (daemon --server target) and
// localServer.cjs (server env). Set it BEFORE any module reads it.
if (!process.env.CUMORA_SKIP_LOCAL_SERVER) {
  process.env.CUMORA_LOCAL_MODE = 'true'
  process.env.CUMORA_REDIS_MODE = 'local'
}

require('./main-core.cjs')
require('./localRuntime.cjs')
