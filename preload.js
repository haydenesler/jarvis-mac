// What the pages in the Mac app may ask of it. Jarvis's window (app.js) sees window.jarvisMac:
// what's asked here is labelled "mac" and spoken here, and the shortcut listens. The set-up
// and offline pages use the rest.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisMac', {
  onTalk: (callback) => ipcRenderer.on('talk', () => callback()),
  show: () => ipcRenderer.send('show'),
  retry: () => ipcRenderer.send('retry'),
  changeAddress: () => ipcRenderer.send('change-address'),
  check: (address) => ipcRenderer.invoke('setup:check', String(address ?? '')),
  current: () => ipcRenderer.invoke('setup:current'),
  sendCode: (code) => ipcRenderer.invoke('setup:code', String(code ?? '')),
  newCode: () => ipcRenderer.invoke('setup:new-code'),
  // "Your PC" (pcview.js): ⌘W, ⌘Q and the like go to the PC while its screen is up; the Mac's clipboard text.
  remoteKeys: (on) => ipcRenderer.send('remote-keys', Boolean(on)),
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
})
