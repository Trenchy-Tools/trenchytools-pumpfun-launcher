/**
 * Many wallets selling one coin in the same instant (the Trading page's Sell all, Close out, the launch's auto-sell).
 * Shared by local mode and demo mode. No node imports.
 */
import type { Env } from "./launch"
import type { TradeResult } from "./trading"

/** what a sell tips for inclusion when the caller names nothing */
const PRIORITY_FEE_SOL = 0.0005
/** builds and sends this many wallets' sells per burst (the API allows 25 requests a second per key) */
const SELL_WAVE = 20
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type SellAllResult = Array<(TradeResult & { retried?: boolean }) | { publicKey: string; skipped?: string; error?: string; code?: string }>

/**
 * The slippage each sell needs when many wallets sell the same coin at once. Every sell is priced as if it were alone,
 * but they land one after another on the same curve, so the later ones get a worse price: the batch's own price impact
 * (two quotes: the whole batch and a sliver of it) is added on top of the usual allowance, capped at 60 %.
 */
async function batchSlippage(env: Env, mint: string, tokens: number): Promise<number> {
  const base = Math.max(env.slippage, 15)
  if (!(tokens > 0)) return base
  try {
    const [all, sliver] = await Promise.all([env.api.quote(mint, "sell", tokens, false), env.api.quote(mint, "sell", tokens / 1000, false)])
    const a = all.solOut ?? all.quoteOut, b = sliver.solOut ?? sliver.quoteOut
    if (typeof a !== "number" || typeof b !== "number" || !(b > 0)) return 40
    const impact = Math.max(0, 1 - a / (b * 1000))   // 0.3 = the batch gets 30 % less than at today's price
    return Math.min(60, Math.round(base + 200 * impact))   // the last seller pays about twice the average impact
  } catch { return 40 }
}

/**
 * Sell `percent` from each wallet at the same instant: 1. build and sign every sell first (waves of SELL_WAVE), with one
 * slippage for the whole batch, 2. send them all together, 3. confirm them together. At 100 %, every wallet that still
 * holds afterwards sells again right away, wider. Wallets holding none are skipped.
 */
export async function sellAll(env: Env, publicKeys: string[], mint: string, percent: number, priorityFee = PRIORITY_FEE_SOL): Promise<SellAllResult> {
  const first = await sellRound(env, publicKeys, mint, percent, null, priorityFee)
  if (percent < 100) return first.out
  const tried = first.out.filter((r) => !("skipped" in r && r.skipped)).map((r) => r.publicKey)
  if (!tried.length) return first.out
  await sleep(1500)
  const rows = await env.api.balances(tried, mint).catch(() => [])
  const left = rows.filter((r) => (r.token?.raw ?? "0") !== "0").map((r) => r.wallet)
  if (!left.length) return first.out
  const again = await sellRound(env, left, mint, 100, Math.min(75, first.slippage + 20), priorityFee)
  for (const r of again.out) {
    const i = first.out.findIndex((x) => x.publicKey === r.publicKey)
    const ok = "signature" in r
    if (i >= 0 && (ok || !("signature" in first.out[i]))) first.out[i] = ok ? { ...(r as TradeResult), retried: true } : r
  }
  return first.out
}

async function sellRound(env: Env, publicKeys: string[], mint: string, percent: number, slip: number | null, priorityFee: number): Promise<{ out: SellAllResult; slippage: number }> {
  const api = env.api
  const rows = await api.balances(publicKeys, mint)
  const held = new Map(rows.map((r) => [r.wallet, r.token]))
  const pct = Math.max(1, Math.min(100, Math.round(percent)))
  const out: SellAllResult = new Array(publicKeys.length)
  const fail = (i: number, e: unknown) => { out[i] = { publicKey: publicKeys[i], error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code } }
  const waves = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => xs.slice(k * n, k * n + n))

  const todo = publicKeys.map((pk, i) => ({ pk, i })).filter(({ pk, i }) => {
    if ((held.get(pk)?.raw ?? "0") !== "0") return true
    out[i] = { publicKey: pk, skipped: "holds none" }
    return false
  })
  // one slippage for the whole batch: what all of it does to the price
  const total = todo.reduce((t, { pk }) => t + (held.get(pk)?.balance ?? 0) * (pct / 100), 0)
  const slippage = slip ?? (todo.length > 1 ? await batchSlippage(env, mint, total) : env.slippage)

  // 1. build and sign every sell first (all at once, in waves of SELL_WAVE so the API's 25-a-second cap holds)
  type Ready = { i: number; tx: Awaited<ReturnType<typeof api.tradeLocal>> }
  const ready: Ready[] = []
  for (const wave of waves(todo, SELL_WAVE)) {
    await Promise.all(wave.map(async ({ pk, i }) => {
      try {
        const kp = env.wallets.keypairOf(pk) // the key must be backed up: NotBackedUpError otherwise
        const built = await api.tradeLocal({ publicKey: pk, action: "sell", mint, amount: `${pct}%`, denominatedInQuote: "false", slippage, priorityFee, pool: "auto" })
        built.tx.sign([kp])
        ready.push({ i, tx: built })
      } catch (e) { fail(i, e) }
    }))
  }

  // 2. send them all in the same instant (one burst per wave, the waves back to back)
  const sent: Array<Ready & { signature: string }> = []
  for (const wave of waves(ready, SELL_WAVE)) {
    await Promise.all(wave.map(async (r) => {
      try { sent.push({ ...r, signature: (await api.send(r.tx.tx)).signature }) } catch (e) { fail(r.i, e) }
    }))
  }

  // 3. confirm them together (starts spread over a second so the status checks do not all hit at once)
  await Promise.all(sent.map(async (r, k) => {
    await sleep((k % 20) * 50)
    const confirmed = await api.waitConfirmed(r.signature, 25_000).catch(() => false)
    out[r.i] = { publicKey: publicKeys[r.i], signature: r.signature, action: "sell", expected: r.tx.expected, quote: r.tx.quote, venue: r.tx.venue, confirmed }
  }))
  return { out, slippage }
}

