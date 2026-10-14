# Jarvis for Mac

The full Jarvis window on your Mac (settings, cameras, history and all), from the Jarvis that runs on your PC. The PC does everything: the conversation, memory, cameras and connected apps. This app adds what a web page can't do on a Mac:

- its own window, which stays in the menu bar when you close it;
- a keyboard shortcut from anywhere (⌃⌥J), then just say what you need;
- the "Jarvis" wake word, as on the PC, and replies spoken on the Mac for what you ask there;
- Mac notifications for camera alerts, reminders and approvals while the window is behind;
- opening at login, from the menu-bar icon.
- **Your PC** (top bar): your PC's screen, driven with the Mac's mouse, trackpad and keyboard. ⌘ works as Ctrl, two-finger scrolling scrolls, and there are buttons for Start, Switch window, Paste from Mac, the other monitor and full screen. It needs Settings → Remote switched on; pressing Esc twice at the PC stops it.

## Install

1. Install [Tailscale](https://tailscale.com/download/mac) and sign in with the same account as the PC.
2. Download the latest `Jarvis-x.y.z.dmg` from [Releases](../../releases), open it, and drag Jarvis into Applications.
3. Open Jarvis. macOS says it can't check the app, because it isn't signed with a paid Apple developer certificate. Open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Jarvis. This happens once.
4. Paste your PC's Jarvis address (the part ending in `.ts.net`, from Jarvis's phone page) and click **Connect**.
5. Jarvis shows a six-digit code on the PC and sends it to your phone. Type it on the Mac and click **Pair this Mac** (once only). Allow the microphone when asked.

New versions show up in the menu-bar icon's menu as "Download Jarvis x.y.z". They're rare, because everything Jarvis does comes from the PC.

## Building

GitHub builds it on a Mac (`.github/workflows/build.yml`). Push a version tag to build and publish a release:

```
git tag v1.0.1 && git push origin v1.0.1
```

To build only (the `.dmg` is kept with the run under Artifacts), use **Actions → Build the Mac app → Run workflow**. On a Mac, `npm ci && npm run build` builds it locally.
