/* eslint-env node */
const { contextBridge, ipcRenderer } = require('electron')

/** Renderer-side surface exposed to the React app. */
contextBridge.exposeInMainWorld('cumora', {
  isElectron: true,
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },

  app: {
    isFocused: () => ipcRenderer.invoke('app:is-focused'),
    onFocusChange: (handler) => {
      const wrapped = (_evt, focused) => handler(!!focused)
      ipcRenderer.on('app:focus-state', wrapped)
      return () => ipcRenderer.removeListener('app:focus-state', wrapped)
    },
  },

  dock: {
    setUnreadDot: (visible) => ipcRenderer.send('dock:set-unread-dot', !!visible),
  },

  /** Desktop-owned local Agent runtime host + runtime introspection. */
  localRuntime: {
    status: () => ipcRenderer.invoke('runtime:local-status'),
    connect: (options) => ipcRenderer.invoke('runtime:connect-local', options),
    models: (engine) => ipcRenderer.invoke('runtime:list-models', engine),
    stop: () => ipcRenderer.invoke('runtime:stop-local'),
  },

  notify: {
    push: (payload) => ipcRenderer.send('notification:push', payload),
    dismiss: (id) => ipcRenderer.send('notification:dismiss', id),
    focusConvo: (conversationId) => ipcRenderer.send('notification:focus-convo', conversationId),
    ready: () => ipcRenderer.send('notification:ready'),
    painted: () => ipcRenderer.send('notification:painted'),
    setHeight: (h) => ipcRenderer.send('notification:set-height', h),
    onVisible: (handler) => {
      const wrapped = () => handler()
      ipcRenderer.on('notification:visible', wrapped)
      return () => ipcRenderer.removeListener('notification:visible', wrapped)
    },
    setInteractive: (interactive) => ipcRenderer.send('notification:set-interactive', !!interactive),
    onPush: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('notification:push', wrapped)
      return () => ipcRenderer.removeListener('notification:push', wrapped)
    },
    onFocusConvo: (handler) => {
      const wrapped = (_evt, conversationId) => handler(conversationId)
      ipcRenderer.on('notification:focus-convo', wrapped)
      return () => ipcRenderer.removeListener('notification:focus-convo', wrapped)
    },
  },

  auth: {
    openExternal: (url) => ipcRenderer.invoke('auth:open-external', url),
    arm: () => ipcRenderer.invoke('auth:arm'),
    onToken: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('auth:token', wrapped)
      return () => ipcRenderer.removeListener('auth:token', wrapped)
    },
  },

  update: {
    getAppInfo: () => ipcRenderer.invoke('update:app-info'),
    getStatus: () => ipcRenderer.invoke('update:status'),
    getInfo: () => ipcRenderer.invoke('update:info'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (handler) => {
      const wrapped = (_evt, payload) => handler(payload)
      ipcRenderer.on('auto-update-status', wrapped)
      return () => ipcRenderer.removeListener('auto-update-status', wrapped)
    },
  },
})
