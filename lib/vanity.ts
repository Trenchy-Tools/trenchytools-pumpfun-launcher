/**
 * Vanity mint pool in local mode: `_app/pumpfun-starter/vanity-pool.json` in the wallet folder. The pool and the job
 * runner are lib/core/vanity.ts; this file says where the pool is kept and grinds on this machine.
 *
 * Grinding: one Node worker thread per spare CPU core, each making ed25519 keys with node:crypto (native, no packages:
 * the worker is inline code, so nothing has to be bundled) and testing the base58 address. The first match wins and
 * every worker stops. The key goes straight to the pool file. Mint keypairs hold no funds and are not wallets.
 */
import os from "node:os"
import { Worker } from "node:worker_threads"
import { createVanity, idleJob, type Grinder, type JobView, type PoolEntry } from "./core/vanity"
import { VANITY_POOL_FILE, readJson, serverState, writeJson } from "./paths"

export type { JobView, PoolEntry, PoolView } from "./core/vanity"

/** The worker: plain CommonJS on node builtins only. A suffix-only pattern skips the full base58 encode (the last k
 *  base58 digits of an address are its number mod 58^k). */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const crypto = require('node:crypto')
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const { suffix, prefix, caseSensitive } = workerData
const norm = (s) => (caseSensitive ? s : s.toLowerCase())
const want = norm(suffix), pre = norm(prefix)
const k = suffix.length, M = 58n ** BigInt(k)
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex')), out = ''
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n }
  for (const b of buf) { if (b !== 0) break; out = '1' + out }
  return out
}
function tail(buf) {
  let n = BigInt('0x' + buf.toString('hex')) % M, out = ''
  for (let i = 0; i < k; i++) { out = A[Number(n % 58n)] + out; n /= 58n }
  return out
}
const opts = { publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'der' } }
let n = 0
for (;;) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', opts)
  const pub = publicKey.subarray(publicKey.length - 32)
  n++
  const ok = pre ? (() => { const a = norm(b58(pub)); return a.startsWith(pre) && a.endsWith(want) })() : norm(tail(pub)) === want
  if (ok) {
    const seed = privateKey.subarray(privateKey.length - 32)
    parentPort.postMessage({ n: n % 4000, found: Buffer.concat([seed, pub]).toString('hex') })
    break
  }
  if (n % 4000 === 0) parentPort.postMessage({ n: 4000 })
}
`

const nodeGrind: Grinder = (spec, onProgress) => {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length
  const threads = Math.max(1, Math.min(8, cores - 1))
  const workers: Worker[] = []
  let attempts = 0
  const stop = () => { for (const w of workers) void w.terminate() }
  const done = new Promise<{ secretKey: Uint8Array }>((resolve, reject) => {
    for (let i = 0; i < threads; i++) {
      const w = new Worker(WORKER, { eval: true, workerData: spec })
      workers.push(w)
      w.on("message", (m: { n?: number; found?: string }) => {
        if (m.n) { attempts += m.n; onProgress(attempts) }
        if (m.found) { stop(); resolve({ secretKey: Uint8Array.from(Buffer.from(m.found, "hex")) }) }
      })
      w.on("error", (e) => { stop(); reject(e) })
    }
  })
  return { threads, done, stop }
}

const state = serverState("vanity", () => ({ job: idleJob() as JobView }))

const v = createVanity({
  readPool: () => readJson<PoolEntry[]>(VANITY_POOL_FILE, []),
  writePool: (pool) => writeJson(VANITY_POOL_FILE, pool),
  grind: nodeGrind,
  state,
  where: VANITY_POOL_FILE,
})

export const { pool, jobStatus, randomForLaunch, takeForLaunch, startJob, stopJob } = v
