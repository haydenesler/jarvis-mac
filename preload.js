// What the pages in the Mac app may ask of it. Jarvis's page (phone.js) sees window.jarvisMac
// and turns on its Mac extras; the set-up and offline pages use the rest.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('jarvisMac', {
  onTalk: (callback) => ipcRenderer.on('talk', () => callback()),
  show: () => ipcRenderer.send('show'),
  retry: () => ipcRenderer.send('retry'),
  changeAddress: () => ipcRenderer.send('change-address'),
  check: (address) => ipcRenderer.invoke('setup:check', String(address ?? '')),
  current: () => ipcRenderer.invoke('setup:current'),
})
