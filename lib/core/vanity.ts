/**
 * The vanity mint pool, shared by local mode (lib/vanity.ts: `vanity-pool.json` in the wallet folder) and demo mode
 * (lib/browser/engine.ts: localStorage). Only the storage and the grinder differ, so the logic is one factory: `createVanity`.
 *
 * Grinding happens on YOUR machine (the API has no vanity endpoint: a mint key ground on a server is a key someone else
 * saw). Local mode grinds in Node worker threads (lib/vanity.ts), demo mode in Web Workers (lib/browser/vanity-grind.ts).
 * Every key found is checked against its public key and written to the pool the moment it arrives. Mint keypairs hold
 * no funds and are not wallets: they live in the pool, not among the wallets. No node imports.
 */
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { ApiError } from "../trenchy"

export type PoolEntry = {
  publicKey: string
  secretKey: string // base58
  suffix: string
  prefix: string
  caseSensitive: boolean
  status: "available" | "used"
  createdAt: string
  usedAt?: string
  usedFor?: string // launch id
  source: "api-pool" | "api-job" | "random" | "local"
}
export type PoolView = Omit<PoolEntry, "secretKey">

/** The grind running (or last run) on this machine, as the Vanity page shows it. */
export type JobView = {
  jobId: string | null
  status: "idle" | "running" | "done" | "failed"
  suffix: string
  prefix: string
  caseSensitive: boolean
  attempts: number
  expectedAttempts: number
  elapsedMs: number
  /** attempts per second */
  rate: number
  pooled: boolean
  found: string | null
  error: string | null
  poolReady: Record<string, number>
  /** worker threads grinding */
  threads?: number
}

export const idleJob = (): JobView => ({ jobId: null, status: "idle", suffix: "", prefix: "", caseSensitive: true, attempts: 0, expectedAttempts: 0, elapsedMs: 0, rate: 0, pooled: false, found: null, error: null, poolReady: {} })

// ── grinding ────────────────────────────────────────────────────────────────

export type GrindSpec = { suffix: string; prefix: string; caseSensitive: boolean }
/** Finds a keypair whose base58 address matches the spec. `onProgress` gets the attempts so far; `stop()` ends it early. */
export type Grinder = (spec: GrindSpec, onProgress: (attempts: number) => void) => { threads: number; done: Promise<{ secretKey: Uint8Array }>; stop: () => void }

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
/** Longest suffix + prefix this grinds: 5 characters is ~650 M tries, already many minutes on a laptop. */
export const MAX_VANITY_CHARS = 5

/** How many keys it takes on average: 58 per character, 29 for a letter when case does not matter. */
export function expectedAttempts(spec: GrindSpec): number {
  let n = 1
  for (const ch of spec.prefix + spec.suffix) n *= !spec.caseSensitive && ch.toLowerCase() !== ch.toUpperCase() && ALPHABET.includes(ch.toLowerCase()) && ALPHABET.includes(ch.toUpperCase()) ? 29 : 58
  return n
}

export function validateSpec(spec: GrindSpec): void {
  if (!spec.suffix && !spec.prefix) throw new ApiError("Give a suffix or a prefix", 400, "bad_request")
  for (const ch of spec.prefix + spec.suffix) if (!ALPHABET.includes(ch) && !(!spec.caseSensitive && (ALPHABET.includes(ch.toLowerCase()) || ALPHABET.includes(ch.toUpperCase())))) {
    throw new ApiError(`"${ch}" never appears in a Solana address (base58 has no 0, O, I or l)`, 400, "bad_request")
  }
  if (spec.prefix.length + spec.suffix.length > MAX_VANITY_CHARS) throw new ApiError(`At most ${MAX_VANITY_CHARS} characters (suffix + prefix): each one more is 58 times the work`, 400, "vanity_too_long")
}

/** Whether a base58 address matches the spec (the grinders use the same test). */
export function matchesSpec(address: string, spec: GrindSpec): boolean {
  const a = spec.caseSensitive ? address : address.toLowerCase()
  const s = spec.caseSensitive ? spec.suffix : spec.suffix.toLowerCase()
  const p = spec.caseSensitive ? spec.prefix : spec.prefix.toLowerCase()
  return a.endsWith(s) && a.startsWith(p)
}

/**
 * The pool + grind runner on a storage. `state.job` is the job view (module state on the server, kept across dev
 * reloads; a plain object in the browser). `where` names the pool for log lines.
 */
export function createVanity(o: { readPool: () => PoolEntry[]; writePool: (pool: PoolEntry[]) => void; grind: Grinder; state: { job: JobView }; where: string }) {
  const { readPool, writePool, state } = o
  const view = ({ secretKey: _s, ...rest }: PoolEntry): PoolView => { void _s; return rest }

  const pool = (): PoolView[] => readPool().map(view).reverse()
  const jobStatus = (): JobView => {
    const j = state.job
    if (j.status === "running" && startedAt) j.elapsedMs = Date.now() - startedAt
    return j
  }

  /** Save a keypair to the pool (before anything else happens with it). The secret must reproduce the public key. */
  function store(kp: Keypair, meta: Pick<PoolEntry, "suffix" | "prefix" | "caseSensitive" | "source">, status: PoolEntry["status"] = "available", usedFor?: string): PoolEntry {
    const entry: PoolEntry = { publicKey: kp.publicKey.toBase58(), secretKey: bs58.encode(kp.secretKey), ...meta, status, createdAt: new Date().toISOString(), ...(usedFor ? { usedAt: new Date().toISOString(), usedFor } : {}) }
    const all = readPool()
    if (!all.some((e) => e.publicKey === entry.publicKey)) writePool([...all, entry])
    return entry
  }

  /** A random mint keypair for a launch: saved to the pool as used, so the launch can be traced back to its key. */
  function randomForLaunch(launchId: string): Keypair {
    const kp = Keypair.generate()
    store(kp, { suffix: "", prefix: "", caseSensitive: true, source: "random" }, "used", launchId)
    return kp
  }

  /** Take a pooled key for a launch (a specific one, or the next available `…pump`, else any) and mark it used. */
  function takeForLaunch(launchId: string, publicKey?: string): Keypair {
    const all = readPool()
    const entry = publicKey ? all.find((e) => e.publicKey === publicKey) : all.find((e) => e.status === "available" && e.suffix === "pump") ?? all.find((e) => e.status === "available")
    if (!entry) throw new Error(publicKey ? `Vanity key ${publicKey.slice(0, 8)}… is not in the pool` : "No vanity key available: grind one on the Vanity page first")
    if (entry.status === "used") throw new Error(`Vanity key ${entry.publicKey.slice(0, 8)}… was already used`)
    const kp = Keypair.fromSecretKey(bs58.decode(entry.secretKey))
    entry.status = "used"
    entry.usedAt = new Date().toISOString()
    entry.usedFor = launchId
    writePool(all)
    return kp
  }

  let startedAt = 0
  let running: ReturnType<Grinder> | null = null

  /** Start grinding on this machine; returns at once (the page follows GET /api/vanity/status). */
  async function startJob(p: { suffix?: string; prefix?: string; caseSensitive?: boolean }): Promise<JobView> {
    if (state.job.status === "running") throw new ApiError("A vanity grind is already running; wait for it to finish", 409, "vanity_busy")
    const spec: GrindSpec = { suffix: (p.suffix ?? "").trim(), prefix: (p.prefix ?? "").trim(), caseSensitive: p.caseSensitive !== false }
    validateSpec(spec)
    startedAt = Date.now()
    state.job = { ...idleJob(), jobId: `local-${startedAt.toString(36)}`, status: "running", ...spec, expectedAttempts: expectedAttempts(spec) }
    const j = state.job
    const job = o.grind(spec, (attempts) => {
      j.attempts = attempts
      j.elapsedMs = Date.now() - startedAt
      j.rate = j.elapsedMs > 0 ? Math.round(attempts / (j.elapsedMs / 1000)) : 0
    })
    running = job
    j.threads = job.threads
    job.done.then((found) => {
      const kp = Keypair.fromSecretKey(found.secretKey)
      const address = kp.publicKey.toBase58()
      if (!matchesSpec(address, spec)) { j.status = "failed"; j.error = "the key found does not match the pattern"; return }
      store(kp, { ...spec, source: "local" })
      j.status = "done"
      j.found = address
      j.elapsedMs = Date.now() - startedAt
      console.log(`[vanity] ${address} saved → ${o.where} (${j.attempts.toLocaleString()} attempts in ${(j.elapsedMs / 1000).toFixed(0)} s)`)
    }).catch((e: unknown) => {
      j.status = "failed"
      j.error = e instanceof Error ? e.message : String(e)
    }).finally(() => { running = null })
    return j
  }

  /** Stop the running grind (nothing is saved). */
  function stopJob(): JobView {
    if (running) { running.stop(); running = null; state.job.status = "failed"; state.job.error = "stopped" }
    return state.job
  }

  return { pool, jobStatus, randomForLaunch, takeForLaunch, startJob, stopJob }
}
