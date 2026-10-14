// Jarvis for the Mac: the full Jarvis window, from the Jarvis running on the PC, through Tailscale.
// The PC does everything (the conversation, memory, cameras, connected apps); this app only
// owns what a web page can't do on a Mac: its own window that stays in the menu bar when
// closed, a keyboard shortcut from anywhere, starting at login, the microphone permission,
// and noticing when a newer version of itself is out.
const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, nativeTheme, net, safeStorage, session, shell, systemPreferences } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const NAME = 'Jarvis'
const RELEASES = 'haydenesler/jarvis-mac' // where new versions of this app are published

// ---- preferences: the PC's address and the shortcut ----

// JARVIS_MAC_DATA keeps a test copy's settings apart (and out of the way of a real one).
if (process.env.JARVIS_MAC_DATA) app.setPath('userData', process.env.JARVIS_MAC_DATA)
const PREFS_FILE = path.join(app.getPath('userData'), 'prefs.json')
let prefs = { address: '', deskKey: '', hotkey: 'Control+Option+J' }
try {
  prefs = { ...prefs, ...JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) }
} catch {}
const savePrefs = () => {
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true })
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2))
  } catch {}
}

// The key the PC gave this Mac when it paired, kept in the Mac's keychain (safeStorage).
function deskKey() {
  try {
    return prefs.deskKey ? safeStorage.decryptString(Buffer.from(prefs.deskKey, 'base64')) : ''
  } catch {
    return ''
  }
}
function setDeskKey(key) {
  prefs.deskKey = key ? safeStorage.encryptString(key).toString('base64') : ''
  savePrefs()
}

const origin = () => `https://${prefs.address}`
const ours = (url) => Boolean(prefs.address) && typeof url === 'string' && (url === origin() || url.startsWith(`${origin()}/`))

/** "pc.tailnet.ts.net", whatever was pasted (a whole link, a trailing slash, spaces). */
function cleanAddress(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// ---- one copy at a time ----

if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => showMain())

// Hear its name and speak promptly while the window is behind other apps.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// ---- the window ----

let main = null
let quitting = false
let retry = null

function openExternal(url) {
  try {
    const target = new URL(url)
    if (target.protocol === 'http:' || target.protocol === 'https:' || target.protocol === 'tel:') shell.openExternal(target.href)
  } catch {}
}

function createMain() {
  main = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 420,
    minHeight: 520,
    show: false,
    title: NAME,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  main.once('ready-to-show', () => main.show())

  // Links in replies open in the real browser (Maps, a phone call, a website).
  main.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  main.webContents.on('will-navigate', (event, url) => {
    if (ours(url) || url.startsWith('file:')) return
    event.preventDefault()
    openExternal(url)
  })
  // The PC is off, asleep, or Tailscale isn't connected: say so, and keep trying.
  main.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || quitting || code === -3) return // -3: a newer load replaced this one
    main.loadFile(path.join(__dirname, 'offline.html'), { query: { address: prefs.address } })
    clearTimeout(retry)
    retry = setTimeout(loadJarvis, 8000)
  })
  // Closing the window keeps Jarvis in the menu bar (and listening, if hands-free is on).
  main.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    main.hide()
  })
  if (prefs.address && deskKey()) loadJarvis()
  else main.loadFile(path.join(__dirname, 'setup.html'))
}

function loadJarvis() {
  clearTimeout(retry)
  if (!main || !prefs.address) return
  if (!deskKey()) return main.loadFile(path.join(__dirname, 'setup.html'))
  main.loadURL(`${origin()}/`)
}

function showMain() {
  if (!main) return
  if (main.isMinimized()) main.restore()
  main.show()
  main.focus()
}

// ---- messages from the pages ----

const fromMain = (event) => event.sender === main?.webContents
ipcMain.on('show', (event) => fromMain(event) && showMain())
ipcMain.on('retry', (event) => fromMain(event) && loadJarvis())
ipcMain.on('change-address', (event) => fromMain(event) && main.loadFile(path.join(__dirname, 'setup.html')))
// The set-up page: check the address answers as Jarvis before keeping it.
ipcMain.handle('setup:check', async (event, text) => {
  if (!fromMain(event)) return { ok: false }
  const address = cleanAddress(text)
  if (!address) return { ok: false, error: 'That doesn’t look like an address. It ends in .ts.net, like yourpc.yourname.ts.net.' }
  try {
    const res = await net.fetch(`https://${address}/manifest.webmanifest`, { signal: AbortSignal.timeout(8000) })
    const manifest = await res.json()
    if (!res.ok || !manifest?.start_url) throw new Error(`answered ${res.status}`)
  } catch {
    return { ok: false, error: `Couldn’t reach Jarvis at ${address}. Check the PC is on, and that Tailscale is open and signed in on this Mac with the same account.` }
  }
  if (address !== prefs.address) setDeskKey('')
  prefs.address = address
  savePrefs()
  return askForCode()
})
// Pairing: the PC shows a six-digit code on its window and the phone; typed here, it gives
// this Mac the key for the full window.
async function pair(body) {
  try {
    const res = await net.fetch(`${origin()}/desk/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
    const reply = await res.json().catch(() => ({}))
    return res.ok ? reply : { error: reply.error ?? `The PC answered ${res.status}.` }
  } catch {
    return { error: 'Couldn’t reach the PC. Check it’s on and Tailscale is connected.' }
  }
}
async function askForCode() {
  const reply = await pair({})
  return reply.ok ? { ok: true, address: prefs.address, step: 'code' } : { ok: false, error: reply.error }
}
ipcMain.handle('setup:new-code', (event) => (fromMain(event) ? askForCode() : { ok: false }))
ipcMain.handle('setup:code', async (event, code) => {
  if (!fromMain(event)) return { ok: false }
  const reply = await pair({ code: String(code ?? '') })
  if (!reply.key) return { ok: false, error: reply.error ?? 'That didn’t work. Ask for a new code.' }
  setDeskKey(reply.key)
  setTimeout(loadJarvis, 300)
  return { ok: true }
})
ipcMain.handle('setup:current', (event) => (fromMain(event) ? { address: prefs.address, paired: Boolean(deskKey()) } : {}))

// ---- menu bar, shortcut, start at login ----

let tray = null
let update = null // { version, url } when a newer version is out

function talkNow() {
  // The page listens for one request, no name needed (see phone.js, "on the Mac").
  if (main && ours(main.webContents.getURL())) main.webContents.send('talk')
  else showMain()
}

function buildTrayMenu() {
  if (!tray) return
  const shortcut = prefs.hotkey.replace('Control', '⌃').replace('Option', '⌥').replace('Command', '⌘').replace('Shift', '⇧').replaceAll('+', '')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${NAME}`, click: showMain },
      { label: `Talk now    ${shortcut}`, click: talkNow },
      ...(update ? [{ type: 'separator' }, { label: `Download ${NAME} ${update.version}`, click: () => openExternal(update.url) }] : []),
      { type: 'separator' },
      { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, enabled: app.isPackaged, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { label: 'Change the PC’s address…', click: () => (showMain(), main.loadFile(path.join(__dirname, 'setup.html'))) },
      { type: 'separator' },
      { label: `Quit ${NAME}`, click: quit },
    ]),
  )
}

// The usual Mac menus, so copy, paste and ⌘Q work in the message box.
function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: `Quit ${NAME}`, accelerator: 'Command+Q', click: quit }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ label: 'Reload', accelerator: 'Command+R', click: loadJarvis }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]),
  )
}

// ---- a newer version ----
// This app can't update itself without an Apple developer certificate, but it hardly needs
// to: everything Jarvis does comes from the PC. Once a day it looks for a newer version of
// this window and offers it in the menu bar.
async function checkForUpdate() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${RELEASES}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return
    const release = await res.json()
    const version = String(release.tag_name ?? '').replace(/^v/, '')
    const newer = (a, b) => {
      const [x, y] = [a, b].map((v) => v.split('.').map(Number))
      for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
      return false
    }
    if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion())) return
    update = { version, url: release.html_url }
    buildTrayMenu()
  } catch {}
}

function quit() {
  quitting = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  app.quit()
}

// ---- start ----

app.on('before-quit', () => (quitting = true))
app.on('window-all-closed', () => {}) // stays in the menu bar
app.on('activate', showMain) // clicking the Dock icon

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  buildAppMenu()

  // The microphone and notifications, for Jarvis's own page only. Everything else is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mic = permission === 'media' && (details.mediaTypes ?? []).every((type) => type === 'audio')
    callback((mic || permission === 'notifications') && ours(details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => (permission === 'media' || permission === 'notifications') && ours(requestingOrigin))
  // Every request to the PC carries this Mac's key, so the PC gives it the full window.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://*/*', 'wss://*/*'] }, (details, callback) => {
    const key = ours(details.url.replace(/^wss:/, 'https:')) ? deskKey() : ''
    callback({ requestHeaders: key ? { ...details.requestHeaders, 'X-Jarvis-Desk': key } : details.requestHeaders })
  })
  // macOS asks once whether this app may use the microphone.
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {})

  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip(NAME)
  buildTrayMenu()

  // config: prefs.json "hotkey", written the Mac way ("Control+Option+J").
  try {
    globalShortcut.register(prefs.hotkey.replace('Option', 'Alt'), talkNow)
  } catch {}

  createMain()
  setTimeout(checkForUpdate, 30_000)
  setInterval(checkForUpdate, 24 * 3600_000)
})

app.on('will-quit', () => globalShortcut.unregisterAll())
