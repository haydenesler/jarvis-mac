// Jarvis for the Mac: the full Jarvis window, from the Jarvis running on the PC, through Tailscale.
// The PC does everything (the conversation, memory, cameras, connected apps); this app only
// owns what a web page can't do on a Mac: its own window that stays in the menu bar when
// closed, a keyboard shortcut from anywhere, starting at login, the microphone permission,
// and noticing when a newer version of itself is out.
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, globalShortcut, ipcMain, nativeImage, nativeTheme, net, safeStorage, session, shell, systemPreferences } = require('electron')
const { execFile, spawn } = require('node:child_process')
const { createHash, verify } = require('node:crypto')
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
// "Your PC": while the PC's screen is up, the Mac's menu shortcuts (⌘W, ⌘Q, ⌘H, ⌘R) go to the PC.
ipcMain.on('remote-keys', (event, on) => fromMain(event) && main.webContents.setIgnoreMenuShortcuts(Boolean(on)))
ipcMain.handle('clipboard-text', (event) => (fromMain(event) && ours(main.webContents.getURL()) ? clipboard.readText().slice(0, 4000) : ''))
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
let update = null // { version, url } when a newer version is out but can't be installed here
let staged = null // { version, app } once a newer version is downloaded, checked and waiting

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
      ...(staged ? [{ type: 'separator' }, { label: `Restart to update to ${staged.version}`, click: () => installUpdate(true) }] : update ? [{ type: 'separator' }, { label: `Download ${NAME} ${update.version}`, click: () => openExternal(update.url) }] : []),
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

// ---- updates ----
// Each release (.github/workflows/build.yml) carries latest.json: the update zip's name, size and
// SHA-256, signed with the build's Ed25519 key, a GitHub secret. Before trusting anything this app
// checks that signature against the public key below, then downloads the zip and checks its size
// and hash, unpacks it with ditto, and checks the new app's code signature is valid and made with
// the same certificate as this one. Only then is it kept, to swap in when Jarvis quits (or at
// 3 am, or "Restart to update" in the menu bar). Never an older version, never an unsigned one.
// Where it can't replace itself (run from the .dmg, or a folder it can't write to), it offers
// the download instead.
const UPDATE_KEY = 'MCowBQYDK2VwAyEApj13SmpNUDCszfG5pJbeedHF+rdP++L/RuoZ7u3WdL0='
const CERT_SHA1 = '7d3bd11d5d5b3c3965fdc56257deedf9980a73c5' // Jarvis for Mac (self-signed)

const run = (command, args) => new Promise((resolve, reject) => execFile(command, args, { timeout: 120_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))))
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
/** This app's own bundle (/Applications/Jarvis.app), if it can replace itself there. */
function ownBundle() {
  if (!app.isPackaged || process.platform !== 'darwin') return null
  const bundle = path.resolve(process.execPath, '..', '..', '..')
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/')) return null
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
    return bundle
  } catch {
    return null
  }
}
/** The SHA-1 of the certificate an app was signed with (its leaf). */
async function signedWith(bundle, dir) {
  await run('/usr/bin/codesign', ['--display', `--extract-certificates=${path.join(dir, 'cert')}`, bundle])
  return createHash('sha1').update(fs.readFileSync(path.join(dir, 'cert0'))).digest('hex')
}

let checking = false
async function checkForUpdate() {
  if (checking || staged) return
  checking = true
  const work = path.join(app.getPath('temp'), 'jarvis-update')
  try {
    const res = await net.fetch(`https://github.com/${RELEASES}/releases/latest/download/latest.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return
    const latest = await res.json()
    const { version, zip, size, sha256, signature } = latest
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !newer(version, app.getVersion())) return
    const message = `jarvis-mac|${version}|${zip}|${sha256}|${size}`
    const genuine = verify(null, Buffer.from(message), { key: Buffer.from(UPDATE_KEY, 'base64'), format: 'der', type: 'spki' }, Buffer.from(String(signature), 'base64'))
    if (!genuine || !/^Jarvis-mac-[\d.]+\.zip$/.test(zip) || !/^[0-9a-f]{64}$/.test(sha256)) return console.error('update: latest.json failed its signature check; ignored')
    const page = `https://github.com/${RELEASES}/releases/tag/v${version}`
    if (!ownBundle()) {
      update = { version, url: page }
      return buildTrayMenu()
    }
    const download = await net.fetch(`https://github.com/${RELEASES}/releases/download/v${version}/${zip}`, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!download.ok) return
    const bytes = Buffer.from(await download.arrayBuffer())
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) return console.error('update: the download didn’t match latest.json; ignored')
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, 'update.zip'), bytes)
    await run('/usr/bin/ditto', ['-x', '-k', path.join(work, 'update.zip'), path.join(work, 'unpacked')])
    const next = path.join(work, 'unpacked', 'Jarvis.app')
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', next])
    if ((await signedWith(next, work)) !== CERT_SHA1) return console.error('update: signed with a different certificate; ignored')
    staged = { version, app: next }
    buildTrayMenu()
    notify(`${NAME} ${version} is ready. It installs when you quit ${NAME}, or overnight.`)
    // Overnight, if it hasn't been quit by then.
    const at = new Date()
    at.setHours(3, 0, 0, 0)
    if (at <= new Date()) at.setDate(at.getDate() + 1)
    setTimeout(() => installUpdate(true), at - Date.now())
  } catch (error) {
    console.error('update check failed:', error.message)
  } finally {
    checking = false
  }
}

/**
 * Swaps the checked new version in once this app has quit, using a short shell script that waits
 * for it to exit, keeps the old copy until the new one is in place (and puts it back if anything
 * fails), and opens Jarvis again when asked to.
 */
let installing = false
function installUpdate(relaunch) {
  const bundle = ownBundle()
  if (!staged || !bundle || installing) return
  installing = true
  const script = [
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
    'rm -rf "$3.old"',
    'if mv "$3" "$3.old" && /usr/bin/ditto "$2" "$3"; then rm -rf "$3.old"; else rm -rf "$3"; mv "$3.old" "$3"; fi',
    'rm -rf "$(dirname "$(dirname "$2")")"',
    '[ "$4" = 1 ] && /usr/bin/open "$3"',
  ].join('\n')
  spawn('/bin/sh', ['-c', script, 'jarvis-update', String(process.pid), staged.app, bundle, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref()
  if (relaunch) quit()
}

function notify(body) {
  try {
    new Notification({ title: NAME, body }).show()
  } catch {}
}

function quit() {
  quitting = true
  globalShortcut.unregisterAll()
  tray?.destroy()
  app.quit()
}

// ---- start ----

app.on('before-quit', () => {
  quitting = true
  if (staged) installUpdate(false) // a waiting update goes in as Jarvis quits
})
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
  setTimeout(checkForUpdate, 60_000)
  setInterval(checkForUpdate, 6 * 3600_000)
})

app.on('will-quit', () => globalShortcut.unregisterAll())
