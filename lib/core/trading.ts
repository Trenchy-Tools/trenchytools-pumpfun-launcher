/**
 * Trading after the launch, shared by local mode (lib/trading.ts) and demo mode (lib/browser/engine.ts). Every trade is
 * built by POST /api/sol/trade-local with `pool: "auto"` (follows the coin from the pump.fun curve to PumpSwap), signed
 * with the wallet's key from the store, sent with POST /api/sol/send and confirmed with GET /api/sol/tx/:signature.
 * Live trades come from the API websocket (subscribeTokenTrade); `parseTrade` turns one message into a LiveTrade.
 * No node imports.
 */
import type { Expected, Quote, TokenInfo } from "../trenchy"
import { chain } from "../chain"
import { claimTarget, type Env } from "./launch"
import type { WalletInfo } from "./wallet-record"

const PRIORITY_FEE_SOL = 0.0005

export type Holding = WalletInfo & { sol: number; tokens: number; raw: string }

/** Every wallet with its SOL and this coin's balance (GET /api/sol/balances?wallets=…&mint=…). */
export async function holdings(env: Env, mint: string): Promise<Holding[]> {
  const wallets = env.wallets.list()
  if (!wallets.length) return []
  const rows = await env.api.balances(wallets.map((w) => w.publicKey), mint)
  const by = new Map(rows.map((r) => [r.wallet, r]))
  return wallets.map((w) => ({ ...w, sol: by.get(w.publicKey)?.sol ?? 0, tokens: by.get(w.publicKey)?.token?.balance ?? 0, raw: by.get(w.publicKey)?.token?.raw ?? "0" }))
}

/**
 * GET /api/sol/token/:mint: what the coin is priced in (`quote`), whether it is a Mayhem coin, holder rewards, creator
 * fee. The pages label every amount with `quote.symbol`; a coin the API does not know yet answers with SOL.
 */
export async function tokenInfo(env: Env, mint: string): Promise<TokenInfo & { quote: Quote; custom: boolean }> {
  const t = await env.api.token(mint)
  const quote: Quote = t.quote ?? { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", decimals: 9, kind: "sol" }
  return { ...t, quote, custom: quote.symbol !== "SOL" }
}

/**
 * GET /api/wallets/balances: every wallet's SOL (`native`, the field the pons starter fills with ETH), the coin's balance
 * when `mint` is given, and the balance of a custom pair's quote asset (`quote`) when `quoteMint` is given.
 */
export async function balanceRows(env: Env, mint?: string, quoteMint?: string) {
  const wallets = env.wallets.list()
  if (!wallets.length) return { rows: [] as Array<{ publicKey: string; native: number; sol: number; tokens: number; raw: string; quote?: number }> }
  const keys = wallets.map((w) => w.publicKey)
  const [rows, quotes] = await Promise.all([env.api.balances(keys, mint), quoteMint ? env.api.balances(keys, quoteMint) : Promise.resolve(null)])
  const quoteBy = new Map((quotes ?? []).map((r) => [r.wallet, r.token?.balance ?? 0]))
  return { mint: mint ?? null, quoteMint: quoteMint ?? null, rows: rows.map((r) => ({ publicKey: r.wallet, native: r.sol, sol: r.sol, tokens: r.token?.balance ?? 0, raw: r.token?.raw ?? "0", ...(quoteMint ? { quote: quoteBy.get(r.wallet) ?? 0 } : {}) })) }
}

/** `expected.quoteAmount` is in the coin's quote asset (`quote.symbol`); `sol` is set on SOL coins only. */
export type TradeResult = { publicKey: string; signature: string; action: "buy" | "sell"; expected: Expected; quote: Quote; venue?: string; confirmed: boolean }

/** One wallet sells `percent` of its balance ("NN%" is resolved by the API from the real balance). */
export async function sell(env: Env, publicKey: string, mint: string, percent: number, slippage = env.slippage, confirmMs = 45_000): Promise<TradeResult> {
  const api = env.api
  const pct = Math.max(1, Math.min(100, Math.round(percent)))
  const kp = env.wallets.keypairOf(publicKey) // the key must be backed up: NotBackedUpError otherwise
  const built = await api.tradeLocal({ publicKey, action: "sell", mint, amount: `${pct}%`, denominatedInQuote: "false", slippage, priorityFee: PRIORITY_FEE_SOL, pool: "auto" })
  built.tx.sign([kp])
  const { signature } = await api.send(built.tx)
  const confirmed = await api.waitConfirmed(signature, confirmMs)
  return { publicKey, signature, action: "sell", expected: built.expected, quote: built.quote, venue: built.venue, confirmed }
}

/**
 * One wallet buys for `amount` of the coin's quote asset (SOL on a SOL coin; USDC / the stock / the coin on a custom
 * pair: the wallet must hold it, 409 no_quote_balance otherwise). `partialFill` is for Mayhem coins only: a buy past
 * the remaining supply takes what is left instead of failing.
 */
export async function buy(env: Env, publicKey: string, mint: string, amount: number, slippage = env.slippage, partialFill = false): Promise<TradeResult> {
  const api = env.api
  env.wallets.assertBackedUp(publicKey)
  const kp = env.wallets.keypairOf(publicKey)
  const built = await api.tradeLocal({ publicKey, action: "buy", mint, amount, denominatedInQuote: "true", slippage, priorityFee: PRIORITY_FEE_SOL, pool: "auto", ...(partialFill ? { partialFill: true } : {}) })
  built.tx.sign([kp])
  const { signature } = await api.send(built.tx)
  const confirmed = await api.waitConfirmed(signature, 45_000)
  return { publicKey, signature, action: "buy", expected: built.expected, quote: built.quote, venue: built.venue, confirmed }
}

export { sellAll, type SellAllResult } from "./sell-all"

export type Pnl = {
  spent: number; received: number; net: number; trades: number; truncated: boolean
  /** this coin still held across the wallets */
  tokensHeld: number
  /**
   * What selling everything still held would bring back right now, in the native coin: a live sell quote of all the
   * tokens at once (slippage and pump.fun's fees in it), minus our API fee and each holder's network fee. null when
   * nothing is held or no quote came back. An estimate: the final number exists once every wallet has sold.
   */
  exitNative: number | null
  /** wallets still holding the coin */
  holders: number
  wallets: Array<{ publicKey: string; label: string; spent: number; received: number; net: number; tokens: number }>
}

/**
 * The exact profit or loss of every wallet on this coin (GET /api/sol/pnl, 25 wallets per call): what they paid and got
 * back in SOL, fees included; transfers between the wallets do not count. For a coin launched here, only transactions
 * since the launch are read. Wallets that never touched the coin are left out.
 */
export async function pnl(env: Env, mint: string): Promise<Pnl> {
  const wallets = env.wallets.list()
  const launches = env.launches.list().filter((l) => l.mint === mint)
  const launch = launches[0]
  const since = launch ? Math.floor(new Date(launch.createdAt).getTime() / 1000) - 60 : undefined
  // the wallets in the list, plus every wallet of this coin's launches (archived ones too: only their addresses are needed)
  const roleOf = new Map<string, string>()
  for (const l of launches) {
    const w = l.wallets
    const add = (pk: string | undefined, role: string) => { if (pk && !roleOf.has(pk)) roleOf.set(pk, role) }
    add(w.dev, "dev (archived)"); w.bundle.forEach((pk, i) => add(pk, `bundle ${i + 1} (archived)`)); w.sniper.forEach((pk, i) => add(pk, `sniper ${i + 1} (archived)`))
    w.holder.forEach((pk, i) => add(pk, `later buyer ${i + 1} (archived)`)); (w.volume ?? []).forEach((pk, i) => add(pk, `volume ${i + 1} (archived)`))
  }
  const keys = [...new Set([...wallets.map((w) => w.publicKey), ...roleOf.keys()])]
  if (!keys.length) return { spent: 0, received: 0, net: 0, trades: 0, truncated: false, tokensHeld: 0, exitNative: null, holders: 0, wallets: [] }
  const parts = []
  for (let i = 0; i < keys.length; i += 25) parts.push(await env.api.pnl(mint, keys.slice(i, i + 25), since))
  const held = new Map((await env.api.balances(keys, mint)).map((r) => [r.wallet, r.token?.balance ?? 0]))
  const label = new Map<string, string>([...roleOf.entries(), ...wallets.map((w) => [w.publicKey, w.label] as [string, string])])
  const rows = parts.flatMap((p) => p.wallets).map((w) => ({ publicKey: w.wallet, label: label.get(w.wallet) ?? w.wallet.slice(0, 6), spent: w.spent, received: w.received, net: w.net, tokens: held.get(w.wallet) ?? 0 }))
  const used = rows.filter((r) => r.spent || r.received || r.tokens)
  const sum = (k: "spent" | "received" | "net") => +used.reduce((s, r) => s + r[k], 0).toFixed(9)
  const tokensHeld = used.reduce((s, r) => s + r.tokens, 0)
  const holders = used.filter((r) => r.tokens > 0).length
  let exitNative: number | null = null
  if (tokensHeld > 0) {
    const q = await env.api.quote(mint, "sell", tokensHeld, false).catch(() => null)
    const out = q?.solOut ?? q?.quoteOut
    if (typeof out === "number") exitNative = +Math.max(0, out * (1 - chain.apiFeeRate) - holders * (PRIORITY_FEE_SOL + 0.000005)).toFixed(9)
  }
  return {
    exitNative, holders, spent: sum("spent"), received: sum("received"), net: sum("net"), trades: parts.reduce((s, p) => s + p.trades, 0), truncated: parts.some((p) => p.truncated), tokensHeld: used.reduce((s, r) => s + r.tokens, 0), wallets: used }
}

/** The creator of a coin we launched (from the launch records), else the ★ wallet. */
export function creatorOf(env: Env, mint: string): string | null {
  return env.launches.list().find((l) => l.mint === mint)?.wallets.dev ?? env.wallets.main()?.publicKey ?? null
}

/** GET /api/sol/creator-fees for the coin's creator. */
export async function creatorFees(env: Env, mint: string) {
  const t = claimTarget(env, mint)
  const creator = t.creator ?? creatorOf(env, mint)
  if (!creator) throw new Error("No creator wallet known for this coin")
  if (t.none) return { creator, sol: 0, lamports: "0", none: t.none }
  const fees = await env.api.creatorFees(creator, mint)
  return { creator, sol: fees.sol, lamports: fees.lamports }
}

/** Claim them: trade-local { action: "collectCreatorFee" } signed by the creator. */
export async function collectCreatorFees(env: Env, mint: string): Promise<{ creator: string; signature: string; confirmed: boolean }> {
  const t = claimTarget(env, mint)
  if (t.none) throw new Error(t.none)
  const creator = t.creator ?? creatorOf(env, mint)
  if (!creator) throw new Error("No creator wallet known for this coin")
  const api = env.api
  const kp = env.wallets.keypairOf(creator)
  const built = await api.tradeLocal({ publicKey: creator, action: "collectCreatorFee", mint, priorityFee: 0.0001 })
  built.tx.sign([kp])
  const { signature } = await api.send(built.tx)
  return { creator, signature, confirmed: await api.waitConfirmed(signature, 45_000) }
}

// ── live trades ─────────────────────────────────────────────────────────────

export type LiveTrade = { signature: string; mint: string; type: "buy" | "sell"; trader: string; sol: number; tokens: number; marketCapSol: number | null; timestamp: number; ours: string | null; pool: string | null }

/** The subscribe message for one coin on wss://…/api/sol/data. */
export const tradeSubscription = (mint: string, on = true) => JSON.stringify({ method: on ? "subscribeTokenTrade" : "unsubscribeTokenTrade", keys: [mint] })

/** One websocket message → a trade of `mint`, or null (not a trade, another coin). `ours` labels our own wallets. */
export function parseTrade(data: string, mint: string, ours: (trader: string) => WalletInfo | undefined): LiveTrade | null {
  try {
    const raw = JSON.parse(data) as Record<string, unknown>
    if ((raw.txType !== "buy" && raw.txType !== "sell") || raw.mint !== mint) return null
    const sig = String(raw.signature ?? "")
    if (!sig) return null
    const trader = String(raw.traderPublicKey ?? "")
    const w = ours(trader)
    return {
      signature: sig, mint, type: raw.txType, trader,
      sol: Number(raw.solAmount ?? 0), tokens: Number(raw.tokenAmount ?? 0), marketCapSol: typeof raw.marketCapSol === "number" ? raw.marketCapSol : null,
      timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(), ours: w ? `${w.label} · ${w.role}` : null, pool: typeof raw.pool === "string" ? raw.pool : null,
    }
  } catch {
    return null // not a trade
  }
}
