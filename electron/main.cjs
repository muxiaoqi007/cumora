/* eslint-env node */
// Keep the mature Electron shell in main-core.cjs. Local Runtime 2.0 is a
// separate lifecycle/IPC module so the BYOA desktop integration can evolve
// without turning the already-large window/update/auth entrypoint into another
// runtime switchboard.
require('./main-core.cjs')
require('./localRuntime.cjs')
