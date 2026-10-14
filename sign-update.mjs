// Run by the Mac build (.github/workflows/build.yml): writes latest.json for the app's updater, with
// the update zip's name, size and SHA-256, signed with the build's Ed25519 key (the GitHub secret
// UPDATE_SIGNING_KEY). The app only installs an update whose signature checks out against the
// public key built into it (main.js, UPDATE_KEY).
//   node sign-update.mjs <version> <path to zip>  > latest.json
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const [version, zipPath] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !zipPath) throw new Error('usage: node sign-update.mjs <version> <zip>')
if (!process.env.UPDATE_SIGNING_KEY) throw new Error('UPDATE_SIGNING_KEY is missing.')
const zip = readFileSync(zipPath)
const name = basename(zipPath)
const sha256 = createHash('sha256').update(zip).digest('hex')
const message = `jarvis-mac|${version}|${name}|${sha256}|${zip.length}`
const signature = sign(null, Buffer.from(message), createPrivateKey(process.env.UPDATE_SIGNING_KEY)).toString('base64')
process.stdout.write(`${JSON.stringify({ version, zip: name, size: zip.length, sha256, signature }, null, 2)}\n`)
