/**
 * Demo mode's vanity grinder: Web Workers in this tab, each making Ed25519 keys with WebCrypto (built into the browser,
 * no packages: the worker is an inline blob) and testing the base58 address. The first match wins and every worker
 * stops. Keys never leave the browser. A browser without WebCrypto Ed25519 (older Safari / Chrome) gets a clear error.
 */
import type { Grinder } from "../core/vanity"

const WORKER = `
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes) {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out }
  return out
}
onmessage = async (e) => {
  const { suffix, prefix, caseSensitive } = e.data
  const norm = (s) => (caseSensitive ? s : s.toLowerCase())
  const want = norm(suffix), pre = norm(prefix)
  try { await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) }
  catch { postMessage({ error: 'this browser cannot make Ed25519 keys (WebCrypto): use a current Chrome, Edge, Firefox or Safari, or run the starter locally' }); return }
  for (;;) {
    const keys = await Promise.all(Array.from({ length: 48 }, () => crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])))
    for (const k of keys) {
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
      const a = norm(b58(pub))
      if (a.endsWith(want) && a.startsWith(pre)) {
        const pk8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey))
        const secret = new Uint8Array(64); secret.set(pk8.slice(pk8.length - 32)); secret.set(pub, 32)
        postMessage({ n: 0, found: Array.from(secret) })
        return
      }
    }
    postMessage({ n: keys.length })
  }
}
`

export const browserGrind: Grinder = (spec, onProgress) => {
  const threads = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))
  const url = URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" }))
  const workers: Worker[] = []
  let attempts = 0
  const stop = () => { for (const w of workers) w.terminate(); URL.revokeObjectURL(url) }
  const done = new Promise<{ secretKey: Uint8Array }>((resolve, reject) => {
    for (let i = 0; i < threads; i++) {
      const w = new Worker(url)
      workers.push(w)
      w.onmessage = (e: MessageEvent<{ n?: number; found?: number[]; error?: string }>) => {
        if (e.data.error) { stop(); reject(new Error(e.data.error)); return }
        if (e.data.n) { attempts += e.data.n; onProgress(attempts) }
        if (e.data.found) { stop(); resolve({ secretKey: Uint8Array.from(e.data.found) }) }
      }
      w.onerror = (e) => { stop(); reject(new Error(e.message || "vanity worker failed")) }
      w.postMessage(spec)
    }
  })
  return { threads, done, stop }
}
