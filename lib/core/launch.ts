/**
 * A pump.fun launch, start to finish, on the TrenchyTools API: the executor shared by local mode (lib/launch.ts, keys
 * in the backup folder, run by the server) and demo mode (lib/browser/engine.ts, keys in the visitor's browser, run
 * in the tab). Every function takes the Env (lib/core/env.ts) as its first argument. Read top to bottom:
 *
 *   0. plan         the funding plan (fundingPlan): what every wallet needs. On a custom pair (the coin priced in USDC,
 *                   a stock, another coin) it reads each wallet's quote-asset balance and refuses when one is short;
 *                   options pump.fun would refuse (Mayhem on a stock pair, a creator fee on a SOL coin) are refused
 *                   here with the API's own error.
 *   1. wallets      the ★ wallet is the creator (dev) unless the form names another; the buyers are explicit lists
 *                   `{ publicKey, amount }[]` per group (bundle / snipers / holders) picked on the Launch page. The old
 *                   `count × solEach` shape still works: wallets are then picked by role, missing ones created
 *                   (stored first). Every key must be backed up.
 *   2. mint         a vanity key from the pool, or Keypair.generate() (saved to the pool as used).
 *   3. funding      optional: SOL from the funding wallet to each buyer per the funding plan (plain transfers). The
 *                   quote asset of a custom pair is never moved by this app: the plan says what to send where.
 *   4. lookup table 5–16 bundle buyers: POST /api/sol/lut, sign + send each transaction, wait until `ready`.
 *   5. bundle       POST /api/sol/trade-local with an ARRAY [create(+dev buy, tip), buys…] → sign each →
 *                   POST /api/sol/simulate on the create → POST /api/sol/bundle → GET /api/sol/bundle/:id and
 *                   GET /api/sol/tx/:sig. If Jito refuses or the bundle does not land: create via POST /api/sol/send,
 *                   then each buy one by one.
 *   6. snipers      the moment the create is confirmed: trade-local buy → sign → send, one every `gapMs`.
 *   7. holders      after `delayS`, buys spread over `windowS` with jitter.
 *   8. record       the launch record (mint, wallets by role, signatures; env.launches.save), and the table's rent
 *                   comes back (deactivate now, close ~4 min later).
 *
 * Every stage is emitted through `emit` (the launch log). No node imports.
 */
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { ApiError, isSolQuote, SOL_PAIR, SOL_QUOTE, type BuiltTx, type Expected, type Pair, type Quote, type Simulation, type TradeBody, type Trenchy } from "../trenchy"
import { notIn, type Env as BaseEnv } from "./env"
import { chain } from "../chain"
import { launchWalletLabel, type Role, type WalletInfo } from "./wallet-record"
import { padById, padCoinUrl, padFeatures } from "../launchpad"
import { sellAll } from "./sell-all"
import { startAutomation, type Handle, type SavedAutomation } from "../automations"

/** A Jito bundle holds 5 transactions: the create plus 4. With a lookup table each of the 4 carries 4 buyers. */
export const PLAIN_BUNDLE_WALLETS = 4
export const BUYERS_PER_TX = 4
export const MAX_BUNDLE_WALLETS = PLAIN_BUNDLE_WALLETS * BUYERS_PER_TX
/** The API fee on the SOL side of every buy (0.5 %), so a wallet funded for a buy can also pay it. */
const API_FEE = chain.apiFeeRate
const GAS_RESERVE = chain.gasBuffer
/** how many funding transfers are in flight at once */
const FUND_PARALLEL = 5
/** creating the coin: rent of its accounts + fees, paid by the dev wallet (lib/chain.ts) */
const CREATE_COST = chain.createCost
const LUT_RENT_RESERVE = 0.02
const PRIORITY_FEE_SOL = 0.0005
/**
 * On a custom pair the buy is paid in the quote asset but our fee is still SOL: 0.5 % of the buy's SOL value at a
 * market price, floored at 0.0001 SOL. The plan cannot price the asset, so it keeps a flat reserve per wallet that
 * covers buys up to ~0.4 SOL of value; bigger buys need more SOL in the wallet.
 */
const CUSTOM_PAIR_FEE_RESERVE = 0.002

/** One picked buyer: a wallet of the folder (or null = a new wallet, created at launch) and its buy, in the coin's quote asset. */
export type Buyer = { publicKey: string | null; amount: number }
export type BuyerGroup = { count: number; solEach: number; wallets?: Buyer[] }
/** A buyer with its wallet record. */
export type Picked = WalletInfo & { amount: number }

export type LaunchForm = {
  name: string
  symbol: string
  description: string
  /** from POST /api/ipfs (the Launch page uploads the image first) */
  metadataUri: string
  twitter: string
  telegram: string
  website: string
  mint: { mode: "vanity" | "random"; publicKey?: string }
  /**
   * What the coin is priced and traded in: "" / "SOL", or a symbol / mint from GET /api/sol/pairs (USDC, SPYx, …) or a
   * pump coin's mint. Every amount below (devBuySol, solEach) is in THIS asset; the field names keep "Sol" for history.
   */
  quoteMint: string
  /** pump.fun's agent trades the coin for 24 h (2 B supply, no synthetic migration). SOL / USDC quotes only. */
  mayhemMode: boolean
  /** your creator fee in basis points on a custom pair (0 = pump.fun's schedule; SOL and USDC coins must leave it 0) */
  creatorFeeBps: number
  /** the creator fee goes to the holders, permanently */
  holderReward: boolean
  /** the launchpad (lib/chain.ts launchpads; pump.fun when absent) and its create-body fields ({ venue: "launchlab", platform: "stonkfun" }) */
  launchpad?: string
  venueOptions?: Record<string, unknown>
  /** the creator: the main wallet when empty */
  devWallet?: string
  /** the plan only: the dev wallet will be a new wallet made at launch (the Launch page then sends it as devWallet) */
  devFresh?: boolean
  devBuySol: number
  /**
   * Each buyer group: an explicit list of wallets with their own amounts (the Launch page's "Pick buyers"), or the old
   * `count × solEach` (wallets picked by role, missing ones created). `wallets` wins when it has entries.
   */
  bundle: BuyerGroup
  snipers: BuyerGroup & { gapMs: number }
  holders: BuyerGroup & { delayS: number; windowS: number }
  /** send SOL from the ★ wallet to every buyer first (per the funding plan) */
  fundFirst: boolean
  /** false = no Jito bundle at all: create, then buys one by one */
  useJito: boolean
  slippage: number
  /** how hard every transaction pushes: the priority fee and the Jito tip (× the Settings tip). Default normal. */
  speed?: Speed
  /** the "right after" bundle (useJito off, or the fallback): a random pause between the buys, ms */
  bundleGap?: { fromMs: number; toMs: number }
  /** the "right after" bundle: skip the buys still to come once outside wallets have put in more than this, SOL (0 = never) */
  bundleMaxOutside?: number
  /** sell automatically after the launch (absent = never) */
  autoSell?: AutoSell
  /** claim the creator fees once: after every one of our wallets has sold the coin, or N minutes after the launch (absent = off) */
  claim?: AutoClaim
  /** the volume maker (absent = off) */
  volume?: Volume
}

/**
 * Volume maker: `count` wallets (made by the Launch page right before the launch, so their keys are saved first) get
 * `budget` SOL between them from the main wallet, then buy and sell small amounts at the chosen pace for `minutes`.
 * It runs only while the coin is live: it stops when the time is up, when auto-sell fires, the moment the main wallet
 * has sold everything, or when the wallets run dry; then every volume wallet sells what it holds. SOL coins only.
 */
export type Volume = { count: number; wallets: string[]; budget: number; pace: "light" | "normal" | "heavy"; minutes: number; size?: "calm" | "normal" | "wild" }
const VOLUME_PACE: Record<Volume["pace"], [number, number]> = { light: [8000, 15000], normal: [3000, 7000], heavy: [1000, 3000] }
/**
 * How big each trade is: a buy spends this share of the wallet's spendable SOL, a sell this % of its tokens, and a
 * random wallet sells with probability sellP. "runs" (wild): 3-6 buys in a row, then 2-4 sells, so the chart gets
 * big green and red candles; now and then two trades come quickly (a burst).
 */
const VOLUME_SIZE: Record<NonNullable<Volume["size"]>, { buy: [number, number]; sell: [number, number]; sellP: number; runs: boolean }> = {
  calm: { buy: [0.1, 0.25], sell: [20, 50], sellP: 0.4, runs: false },
  normal: { buy: [0.15, 0.4], sell: [30, 100], sellP: 0.45, runs: false },
  wild: { buy: [0.4, 0.9], sell: [60, 100], sellP: 0.5, runs: true },
}
const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo)

export type Speed = "normal" | "fast" | "turbo"
/** Normal = the Settings tip and a 0.0005 SOL priority fee; Fast and Turbo push harder. */
export const SPEEDS: Record<Speed, { tipX: number; prioritySol: number }> = {
  normal: { tipX: 1, prioritySol: 0.0005 },
  fast: { tipX: 2, prioritySol: 0.001 },
  turbo: { tipX: 4, prioritySol: 0.002 },
}
export const feesOf = (env: Env, form: Pick<LaunchForm, "speed">) => {
  const s = SPEEDS[form.speed ?? "normal"] ?? SPEEDS.normal
  return { tipSol: +((env.jitoTipLamports / LAMPORTS_PER_SOL) * s.tipX).toFixed(6), prioritySol: s.prioritySol }
}

/**
 * Auto-sell: once outside wallets (not ours) have put in `netIn` SOL more than they took out, or `afterMin` minutes after
 * the launch (whichever comes first; 0 turns that trigger off), every buyer wallet sells 100 %: all at once, or spread
 * over `spreadSec`. The main wallet sells with them, `mainLaterSec` later, on its own trigger (`mainNetIn` SOL of
 * outside money or `mainAfterMin` minutes after the launch, watched separately from the buyers'), or keeps its coins.
 */
/** Auto-claim, once: "sold" = when none of our wallets holds the coin any more (after it held some); "after" = afterMin minutes after the launch. */
export type AutoClaim = { when: "sold" | "after"; afterMin: number }

export type AutoSell = { netIn: number; afterMin: number; bundle: "all" | "spread"; spreadSec: number; main: "with" | "later" | "own" | "keep"; mainLaterSec: number; mainNetIn?: number; mainAfterMin?: number }

/** Whether an auto-sell rule can ever fire (the buyers' trigger, or the main wallet's own). */
export const autoSellArmed = (a: AutoSell | undefined): boolean =>
  !!a && (a.netIn > 0 || a.afterMin > 0 || (a.main === "own" && ((a.mainNetIn ?? 0) > 0 || (a.mainAfterMin ?? 0) > 0)))

export type LaunchRecord = {
  id: string
  name: string
  symbol: string
  mint: string | null
  status: "running" | "confirmed" | "error"
  createdAt: string
  wallets: { dev: string; bundle: string[]; sniper: string[]; holder: string[]; volume?: string[] }
  signatures: { create?: string; bundleId?: string; snipers: string[]; holders: string[] }
  lookupTable?: string
  /** the pair the coin trades in (absent on records from before custom pairs = SOL) and the create options */
  quote?: Quote
  mayhem?: boolean
  holderReward?: boolean
  creatorFeeBps?: number
  /** the launchpad it was made on (lib/chain.ts launchpads id) */
  pad?: string
  /** what the launch keeps running after the coin is live (lib/automations.ts), as last saved */
  automations?: SavedAutomation[]
  error?: string
}

export type LaunchEvent = { at: number; stage: string; message: string; signature?: string; mint?: string; link?: string }

export type Env = BaseEnv<LaunchRecord>
export type Emit = (stage: string, message: string, extra?: Partial<LaunchEvent>) => void

// ── funding plan ────────────────────────────────────────────────────────────

export type PlanRow = {
  role: Role | "dev"; label: string; publicKey: string | null
  /** the buy, in the coin's quote asset (SOL unless the form picks a pair) */
  buy: number
  /** SOL the wallet needs: on a SOL coin buy + 0.5 % fee + 0.01 reserve; on a custom pair the 0.01 reserve + the API-fee reserve. The dev adds the tip and the table rent. */
  needSol: number
  /** custom pair only: quote asset the wallet needs (buy + slippage), what it holds, and what is missing */
  needQuote?: number; haveQuote?: number; sendQuote?: number; quoteAccount?: string | null
}
export type Shortfall = { role: string; label: string; publicKey: string | null; send: number; symbol: string; account: string | null }
export type Refusal = { error: string; code?: string; hint?: string; docs?: string; status: number; [k: string]: unknown }
export type Plan = {
  rows: PlanRow[]
  /** SOL the funding wallet pays out in total (every row's needSol) */
  total: number
  tipSol: number; useLut: boolean
  /** the coin's quote asset; `custom` when it is not SOL */
  quote: Quote; custom: boolean
  mayhem: boolean; holderReward: boolean; creatorFeeBps: number
  /** custom pair: quote asset the whole launch needs, and the wallets that must still receive some ("send X SYMBOL to …") */
  totalQuote: number
  shortfalls: Shortfall[]
  /** the API refused the options (mayhem_quote_not_allowed, creator_fee_not_allowed, holder_reward_disabled, …): its error, verbatim */
  refusal: Refusal | null
  /** launchable: no refusal and no wallet short of the quote asset */
  ok: boolean
}

/** Sums of lamport-sized numbers without float dust (9 decimals). */
const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 1e9) / 1e9

/** Codes the plan reports as a refusal. Anything else (a short balance, a node hiccup) is left to Simulate / Launch. */
const REFUSALS = new Set(["mayhem_quote_not_allowed", "mayhem_disabled", "creator_fee_not_allowed", "holder_reward_disabled", "unsupported_quote", "quote_not_eligible", "launch_disabled"])

/** The create body the launch sends, from the form: quote, Mayhem, holder rewards and creator fee only when set. */
function createBody(form: LaunchForm, creator: string, mint: string, pair: Pair, priorityFee: number, uri = form.metadataUri): TradeBody {
  const custom = !isSolQuote(pair)
  return {
    publicKey: creator, action: "create", mint, tokenMetadata: { name: form.name, symbol: form.symbol, uri },
    amount: form.devBuySol, ...(custom ? { denominatedInQuote: "true" as const } : { denominatedInSol: "true" as const }), slippage: form.slippage, priorityFee, pool: "pump",
    ...(custom ? { quoteMint: pair.mint } : {}),
    ...(form.mayhemMode ? { mayhemMode: true } : {}),
    ...(form.holderReward ? { holderReward: true } : {}),
    ...(custom && form.creatorFeeBps > 0 ? { creatorFeeBps: Math.round(form.creatorFeeBps) } : {}),
    // the launchpad's own fields last: venue + platform for a LaunchLab pad (pump.fun's are the defaults above)
    ...(form.venueOptions ?? {}),
  } as TradeBody
}

/** The explicit buyers of a group, or null when the form uses the old count × solEach shape. */
const explicit = (g: BuyerGroup): Buyer[] | null => (g.wallets && g.wallets.length ? g.wallets : null)
/** How many buyers a group has, whichever shape it uses. */
export const groupSize = (g: BuyerGroup): number => explicit(g)?.length ?? g.count
/** The creator: the form's dev wallet (must be in the store) or the ★ wallet. */
export function devWallet(env: Env, form: LaunchForm): WalletInfo | null {
  if (form.devWallet) return env.wallets.get(form.devWallet)
  return env.wallets.main()
}

/** The SOL rows: unchanged for a SOL coin (buy + 0.5 % fee + 0.01 reserve; dev + tip + table rent). Explicit buyers keep their own amounts. */
function solRows(env: Env, form: LaunchForm, custom: boolean): { rows: PlanRow[]; tipSol: number; useLut: boolean } {
  const { tipSol } = feesOf(env, form)
  const useLut = form.useJito && groupSize(form.bundle) > PLAIN_BUNDLE_WALLETS
  const need = (buy: number) => (custom ? GAS_RESERVE + (buy > 0 ? CUSTOM_PAIR_FEE_RESERVE : 0) : buy * (1 + API_FEE) + GAS_RESERVE)
  const dev = form.devFresh ? null : devWallet(env, form)
  const rows: PlanRow[] = [{ role: "dev", label: form.devFresh ? "new dev wallet (made at launch)" : dev?.label ?? (form.devWallet ? `${form.devWallet.slice(0, 6)}… (${notIn(env.wallets)})` : "Main wallet"), publicKey: form.devFresh ? null : dev?.publicKey ?? form.devWallet ?? null, buy: form.devBuySol, needSol: need(form.devBuySol) + padFeatures(padById(form.launchpad)).createCost + (form.useJito ? tipSol : 0) + (useLut ? LUT_RENT_RESERVE : 0) }]
  const group = (role: Exclude<Role, "funding" | "trader">, g: BuyerGroup) => {
    const picked = explicit(g)
    if (picked) {
      picked.forEach((b, i) => {
        if (!b.publicKey) { rows.push({ role, label: `${role === "bundle" ? "buyer" : role === "holder" ? "later buyer" : role} ${i + 1} (new)`, publicKey: null, buy: b.amount, needSol: need(b.amount) }); return }
        const w = env.wallets.get(b.publicKey)
        rows.push({ role, label: w?.label ?? `${b.publicKey.slice(0, 6)}… (${notIn(env.wallets)})`, publicKey: b.publicKey, buy: b.amount, needSol: need(b.amount) })
      })
      return
    }
    const have = env.wallets.list(role)
    for (let i = 0; i < g.count; i++) rows.push({ role, label: have[i]?.label ?? `${role === "bundle" ? "buyer" : role === "holder" ? "later buyer" : role} ${i + 1} (new)`, publicKey: have[i]?.publicKey ?? null, buy: g.solEach, needSol: need(g.solEach) })
  }
  group("bundle", form.bundle)
  group("sniper", form.snipers)
  group("holder", form.holders)
  const v = form.volume
  if (v && v.count > 0 && !custom) {
    for (let i = 0; i < v.count; i++) {
      const pk = v.wallets[i] ?? null
      rows.push({ role: "trader", label: (pk && env.wallets.get(pk)?.label) || `volume ${i + 1} (new)`, publicKey: pk, buy: 0, needSol: +(v.budget / v.count + GAS_RESERVE).toFixed(6) })
    }
  }
  return { rows, tipSol, useLut }
}

/**
 * What every wallet needs before the launch.
 *   SOL coin: buy + 0.5 % API fee + 0.01 SOL reserve; the dev (funding wallet) also pays the Jito tip and, with 5+
 *             bundle buyers, the lookup table's rent (refunded on close). No API call.
 *   Custom pair (USDC / a stock / a coin): the buy is in the quote asset, so each wallet's balance of it is read
 *             (GET /api/sol/balances?wallets=…&mint=<quote>) and compared with buy + slippage; SOL is still needed for
 *             network fees and our fee (0.01 + a small reserve). Wallets short of the quote asset go to `shortfalls`
 *             ("send X SYMBOL to …") and the plan is not ok. This app never moves the quote asset itself.
 *   Options:  Mayhem, holder rewards or a creator fee are checked by building the create once against the API with a
 *             throwaway mint (nothing is sent): a 422 like `mayhem_quote_not_allowed` comes back verbatim as `refusal`.
 */
export async function fundingPlan(env: Env, form: LaunchForm): Promise<Plan> {
  const api = env.api
  const wantsOptions = form.mayhemMode || form.holderReward || form.creatorFeeBps > 0
  const plain = !form.quoteMint.trim() || form.quoteMint.trim().toUpperCase() === "SOL"
  if (plain && !wantsOptions) {
    const { rows, tipSol, useLut } = solRows(env, form, false)
    return { rows, total: sum(rows.map((r) => r.needSol)), tipSol, useLut, quote: SOL_QUOTE, custom: false, mayhem: false, holderReward: false, creatorFeeBps: 0, totalQuote: 0, shortfalls: [], refusal: null, ok: true }
  }

  let pair: Pair
  let refusal: Refusal | null = null
  try {
    pair = await api.resolvePair(form.quoteMint)
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    refusal = e.toJSON()
    pair = SOL_PAIR
  }
  const quote: Quote = { mint: pair.mint, symbol: pair.symbol, decimals: pair.decimals, kind: pair.kind }
  const custom = !isSolQuote(quote)
  const { rows, tipSol, useLut } = solRows(env, form, custom)
  const base = { rows, tipSol, useLut, quote, custom, mayhem: form.mayhemMode, holderReward: form.holderReward, creatorFeeBps: custom ? Math.round(form.creatorFeeBps) : 0 }

  // the options, judged by the API itself (a build with a throwaway mint; the dev's quote balance is checked below)
  const dev = devWallet(env, form)
  if (!refusal && wantsOptions && dev) {
    try {
      await api.tradeLocal(createBody({ ...form, name: form.name || "Plan", symbol: form.symbol || "PLAN" }, dev.publicKey, Keypair.generate().publicKey.toBase58(), pair, PRIORITY_FEE_SOL, form.metadataUri || "https://trenchy.tools/simulate.json"))
    } catch (e) {
      if (e instanceof ApiError && e.code && REFUSALS.has(e.code)) refusal = e.toJSON()
      else if (!(e instanceof ApiError)) throw e
    }
  }

  if (!custom) {
    return { ...base, total: sum(rows.map((r) => r.needSol)), totalQuote: 0, shortfalls: [], refusal, ok: !refusal }
  }

  // custom pair: the quote asset each wallet holds vs buy + slippage
  const slip = 1 + Math.max(1, form.slippage) / 100
  const known = rows.map((r) => r.publicKey).filter((k): k is string => !!k)
  const balances = new Map((known.length ? await api.balances(known, quote.mint) : []).map((b) => [b.wallet, b.token]))
  const round = (n: number) => Math.ceil(n * 10 ** Math.min(quote.decimals, 9)) / 10 ** Math.min(quote.decimals, 9)
  const shortfalls: Shortfall[] = []
  for (const r of rows) {
    r.needQuote = round(r.buy * slip)
    const t = r.publicKey ? balances.get(r.publicKey) : undefined
    r.haveQuote = t?.balance ?? 0
    r.quoteAccount = t?.account ?? null
    r.sendQuote = Math.max(0, round(r.needQuote - r.haveQuote))
    if (r.sendQuote > 0) shortfalls.push({ role: r.role, label: r.label, publicKey: r.publicKey, send: r.sendQuote, symbol: quote.symbol, account: r.quoteAccount })
  }
  return { ...base, total: sum(rows.map((r) => r.needSol)), totalQuote: sum(rows.map((r) => r.needQuote ?? 0)), shortfalls, refusal, ok: !refusal && shortfalls.length === 0 }
}

/** One line per problem, for an error message or the launch log. */
export function planProblems(plan: Plan): string[] {
  const out: string[] = []
  if (plan.refusal) out.push(`${plan.refusal.error}${plan.refusal.code ? ` · ${plan.refusal.code}` : ""}${plan.refusal.hint ? ` · ${plan.refusal.hint}` : ""}`)
  for (const s of plan.shortfalls) out.push(s.publicKey ? `send ${s.send} ${s.symbol} to ${s.publicKey} (${s.label})` : `${s.label}: create the wallet on the Wallets page first, then send it ${s.send} ${s.symbol}`)
  return out
}

/**
 * The buyers of a group with their amounts: the explicit list (every wallet must be in the folder), or the first
 * `count` wallets of the role, creating (and backing up) the missing ones. Every returned wallet has its file.
 */
function pick(env: Env, role: Exclude<Role, "funding" | "trader">, g: BuyerGroup, symbol?: string): Picked[] {
  const picked = explicit(g)
  if (picked) {
    // "new wallet" rows (publicKey null) are created here, all at once, stored before anything else happens. Only when
    // there are some: create(0) used to make one wallet anyway, so every launch left an unused wallet per group, twice.
    const missing = picked.filter((b) => !b.publicKey).length
    const fresh = missing > 0 ? env.wallets.create(missing, role, launchWalletLabel(symbol, role)) : []
    return picked.map((b) => {
      const publicKey = b.publicKey ?? fresh.shift()!.publicKey
      env.wallets.assertBackedUp(publicKey) // unknown or not backed up: NotBackedUpError
      const w = env.wallets.get(publicKey)!
      return { ...w, amount: b.amount }
    })
  }
  const have = env.wallets.list(role).slice(0, g.count)
  const made = g.count > have.length ? env.wallets.create(g.count - have.length, role, launchWalletLabel(symbol, role)) : []
  const all = [...have, ...made].map((w) => ({ ...w, amount: g.solEach }))
  for (const w of all) env.wallets.assertBackedUp(w.publicKey)
  return all
}

/** "0.05 SOL each", or the range when the picked amounts differ. */
function amounts(ws: Picked[], sym: string): string {
  const xs = ws.map((w) => w.amount)
  const lo = Math.min(...xs), hi = Math.max(...xs)
  return lo === hi ? `${lo} ${sym} each` : `${lo}–${hi} ${sym}`
}

/**
 * The form with every "new wallet" row (publicKey null) replaced by a wallet created now, so the plan, the funding and
 * the launch all see the same keys. A form without such rows comes back as is. Creation stores the key first.
 */
export function materialize(env: Env, form: LaunchForm): LaunchForm {
  const fill = <G extends BuyerGroup>(g: G, role: Exclude<Role, "funding" | "trader">): G => {
    const picked = explicit(g)
    if (!picked || !picked.some((b) => !b.publicKey)) return g
    const fresh = env.wallets.create(picked.filter((b) => !b.publicKey).length, role, launchWalletLabel(form.symbol, role))
    return { ...g, wallets: picked.map((b) => ({ publicKey: b.publicKey ?? fresh.shift()!.publicKey, amount: b.amount })) }
  }
  return { ...form, bundle: fill(form.bundle, "bundle"), snipers: fill(form.snipers, "sniper"), holders: fill(form.holders, "holder") }
}

/**
 * Top up every buyer in the plan from the ★ wallet (plain SOL transfers, confirmed one by one). On a custom pair
 * this is the SOL reserve only: the quote asset must reach the wallets by other means (the plan lists the amounts).
 */
export async function fundPlan(env: Env, form: LaunchForm, note: (msg: string) => void = () => {}): Promise<Array<{ publicKey: string; role: string; sent: number; signature?: string; error?: string }>> {
  const api = env.api
  const funding = env.wallets.main()
  if (!funding) throw new Error("No main wallet yet: create one at the top of the Launch or Wallets page")
  const fundingKp = env.wallets.keypairOf(funding.publicKey)
  form = materialize(env, form)
  const plan = await fundingPlan(env, form)
  if (plan.refusal) throw new ApiError(plan.refusal.error, plan.refusal.status, plan.refusal.code, plan.refusal.hint, plan.refusal.docs)
  const volume = (form.volume?.wallets ?? []).map((pk) => env.wallets.get(pk)).filter((w): w is WalletInfo => !!w)
  // a dev wallet that is not the main wallet is topped up too (its buy, the tip, the table rent, gas)
  const dev = devWallet(env, form)
  const buyers: WalletInfo[] = [...(dev && dev.publicKey !== funding.publicKey ? [dev] : []), ...pick(env, "bundle", form.bundle, form.symbol), ...pick(env, "sniper", form.snipers, form.symbol), ...pick(env, "holder", form.holders, form.symbol), ...volume].filter((w) => w.publicKey !== funding.publicKey)
  if (!buyers.length) return []
  const balances = new Map((await api.balances(buyers.map((b) => b.publicKey))).map((b) => [b.wallet, b.sol]))
  // every wallet is checked before anything moves (one missing key file stops the whole funding, nothing half-sent)
  for (const w of buyers) env.wallets.assertBackedUp(w.publicKey)
  // FUND_PARALLEL top-ups in flight at once: independent transfers from the same main wallet, each sent, re-sent and
  // confirmed on its own (about 5x faster than one by one; well inside the API's 25 requests a second)
  const out: Array<{ publicKey: string; role: string; sent: number; signature?: string; error?: string }> = new Array(buyers.length)
  let next = 0
  const worker = async () => {
    while (next < buyers.length) {
      const i = next++
      const w = buyers[i]
      const need = plan.rows.find((r) => r.publicKey === w.publicKey)?.needSol ?? 0
      const topUp = Math.round((need - (balances.get(w.publicKey) ?? 0)) * 1e6) / 1e6
      if (topUp <= 0.0005) { out[i] = { publicKey: w.publicKey, role: w.role, sent: 0 }; continue }
      try {
        const signature = await api.transferSol(fundingKp, env.wallets.keypairOf(w.publicKey).publicKey, topUp)
        note(`${w.label}: +${topUp} SOL (${signature.slice(0, 8)}…)`)
        out[i] = { publicKey: w.publicKey, role: w.role, sent: topUp, signature }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        note(`${w.label}: funding failed: ${error}`)
        out[i] = { publicKey: w.publicKey, role: w.role, sent: 0, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FUND_PARALLEL, buyers.length) }, worker))
  if (plan.shortfalls.length) note(`Quote asset still missing (this app moves SOL only): ${planProblems(plan).join("; ")}`)
  return out
}

// ── the launch ──────────────────────────────────────────────────────────────

/** Which unit `amount` is in: the quote asset either way, under the name that reads right for the pair. */
const denom = (custom: boolean) => (custom ? { denominatedInQuote: "true" as const } : { denominatedInSol: "true" as const })
/** A buy on the curve. Custom-pair coins keep `pool: "pump"` (and `"auto"` after the launch): the API reads the pair from the coin. */
const buyBody = (publicKey: string, mint: string, amount: number, slippage: number, priorityFee: number, custom: boolean): TradeBody => ({ publicKey, action: "buy", mint, amount, ...denom(custom), slippage, priorityFee, pool: "auto" })

/**
 * Check the form and record a new launch (status running). The caller then runs it: `void runLaunch(env, rec, form, emit)`
 * (the server in the background, the browser in the tab).
 */
export function prepareLaunch(env: Env, form: LaunchForm): LaunchRecord {
  const dev = devWallet(env, form)
  if (!dev) throw new Error(form.devWallet ? `Main wallet ${form.devWallet.slice(0, 8)}… is ${notIn(env.wallets, true)}` : "No main wallet yet: create one at the top of the Launch or Wallets page")
  if (!form.name || !form.symbol) throw new Error("Name and symbol are required")
  if (!form.metadataUri) throw new Error("Upload the image first (the metadata URI is missing)")
  const pad = padById(form.launchpad)
  if (pad.disabled) throw new Error(`${pad.name} cannot launch right now: ${pad.disabled}`)
  if (form.useJito && padFeatures(pad).sameBlock && groupSize(form.bundle) > MAX_BUNDLE_WALLETS) throw new Error(`At most ${MAX_BUNDLE_WALLETS} bundle buyers (4 transactions of ${BUYERS_PER_TX} with a lookup table); add the rest as snipers or holders`)
  env.wallets.assertBackedUp(dev.publicKey)
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  const rec: LaunchRecord = { id, name: form.name, symbol: form.symbol, mint: null, status: "running", createdAt: new Date().toISOString(), wallets: { dev: dev.publicKey, bundle: [], sniper: [], holder: [] }, signatures: { snipers: [], holders: [] }, pad: padById(form.launchpad).id }
  env.launches.save(rec)
  return rec
}

/** Run a prepared launch to the end. Never throws: a failure is recorded on the launch and emitted as stage "error". */
export async function runLaunch(env: Env, rec: LaunchRecord, form: LaunchForm, emit: Emit): Promise<void> {
  const api = env.api
  const { tipSol, prioritySol } = feesOf(env, form)
  const saveLaunch = (r: LaunchRecord) => env.launches.save(r)
  const keypairOf = (pk: string) => env.wallets.keypairOf(pk)
  const pad = padById(form.launchpad)
  const pf = padFeatures(pad)
  const padLink = (m: string) => padCoinUrl(pad, m)
  // only pump.fun coins can be bought inside the bundle that creates them: elsewhere the bundle buys go right after
  if (!pf.sameBlock && form.useJito) form = { ...form, useJito: false }
  try {
    // 0. plan: the pair, the options and (custom pair) every wallet's quote-asset balance. "New wallet" rows are created first.
    form = materialize(env, form)
    const plan = await fundingPlan(env, form)
    if (!plan.ok) throw new Error(`Not launched: ${planProblems(plan).join("; ")}`)
    const pair = await api.resolvePair(form.quoteMint)
    const custom = plan.custom
    const sym = plan.quote.symbol
    rec.quote = plan.quote; rec.mayhem = plan.mayhem; rec.holderReward = plan.holderReward; rec.creatorFeeBps = plan.creatorFeeBps
    const opts = [custom ? `paired with ${sym}` : "paired with SOL", plan.mayhem ? "Mayhem mode" : "", plan.holderReward ? "holder rewards" : "", plan.creatorFeeBps ? `creator fee ${plan.creatorFeeBps} bps` : ""].filter(Boolean)
    emit("plan", `${opts.join(" · ")}; ${plan.total.toFixed(4)} SOL${custom ? ` + ${plan.totalQuote} ${sym} across the wallets` : ""}`)

    // 1. wallets
    const devKp = keypairOf(rec.wallets.dev)
    const bundle = pick(env, "bundle", form.bundle, form.symbol)
    const snipers = pick(env, "sniper", form.snipers, form.symbol)
    const holders = pick(env, "holder", form.holders, form.symbol)
    rec.wallets = { dev: rec.wallets.dev, bundle: bundle.map((w) => w.publicKey), sniper: snipers.map((w) => w.publicKey), holder: holders.map((w) => w.publicKey), volume: form.volume?.wallets ?? [] }
    emit("wallets", `Creator ${rec.wallets.dev.slice(0, 8)}… · ${bundle.length} bundle · ${snipers.length} sniper · ${holders.length} holder wallet(s), all backed up`)

    // 2. mint
    const mintKp = form.mint.mode === "vanity" ? env.mints.takeForLaunch(rec.id, form.mint.publicKey) : env.mints.randomForLaunch(rec.id)
    const mint = mintKp.publicKey.toBase58()
    rec.mint = mint
    saveLaunch(rec)
    emit("mint", `Mint ${mint} (${form.mint.mode}, saved to the vanity pool)`, { mint })

    // 3. funding (SOL only; on a custom pair the plan above already made sure every wallet holds its quote asset)
    if (form.fundFirst) {
      emit("fund", `Funding buyers from the main wallet${custom ? " (SOL for fees; the buys are paid in " + sym + ")" : ""}…`)
      const r = await fundPlan(env, form, (m) => emit("fund", m))
      const failed = r.filter((x) => x.error)
      if (failed.length) throw new Error(`${failed.length} wallet(s) could not be funded; nothing launched`)
      emit("fund", `Funding done (${r.filter((x) => x.sent > 0).length} transfer(s))`)
    }

    const create = createBody(form, rec.wallets.dev, mint, pair, form.useJito ? tipSol : prioritySol)
    let createSig: string | null = null

    if (form.useJito) {
      // 4. lookup table for 5–16 buyers
      let lookupTable: string | undefined
      if (bundle.length > PLAIN_BUNDLE_WALLETS) {
        emit("lut", `Creating a lookup table for ${bundle.length} buyers (POST /api/sol/lut)…`)
        const lut = await api.lutCreate({ authority: rec.wallets.dev, mint, wallets: bundle.map((w) => w.publicKey), creator: rec.wallets.dev, ...(custom ? { quoteMint: pair.mint } : {}) })
        for (const [i, tx] of lut.txs.entries()) {
          tx.sign([devKp])
          const { signature } = await api.send(tx)
          if (!(await api.waitConfirmed(signature, 60_000))) throw new Error(`Lookup table transaction ${i + 1}/${lut.txs.length} did not confirm`)
        }
        for (let i = 0; i < 30 && !(await api.lutInfo(lut.lookupTable).catch(() => null))?.ready; i++) await sleep(1000)
        lookupTable = lut.lookupTable
        rec.lookupTable = lookupTable
        emit("lut", `Lookup table ${lookupTable.slice(0, 8)}… ready (${lut.addresses} addresses, ${lut.rentSol.toFixed(4)} SOL rent, refunded after the launch)`)
      }

      // 5. bundle: create first, then the buys (one wallet per tx, or BUYERS_PER_TX per tx through the table)
      const groups: Picked[][] = []
      bundle.forEach((w, i) => { if (i % (lookupTable ? BUYERS_PER_TX : 1) === 0) groups.push([]); groups[groups.length - 1].push(w) })
      const buys: TradeBody[] = groups.map((g) => lookupTable
        ? { action: "buy", mint, lookupTable, ...denom(custom), slippage: form.slippage, priorityFee: 0, buyers: g.map((w) => ({ publicKey: w.publicKey, amount: w.amount })) }
        : buyBody(g[0].publicKey, mint, g[0].amount, form.slippage, 0, custom))
      emit("build", `Building the bundle: create + dev buy ${form.devBuySol} ${sym}${bundle.length ? ` + ${bundle.length} buyer(s) in ${groups.length} tx` : ""}, tip ${tipSol} SOL (POST /api/sol/trade-local)`)
      const built: BuiltTx[] = await api.bundleLocal([create, ...buys])
      built[0].tx.sign([devKp, mintKp])
      groups.forEach((g, i) => built[i + 1].tx.sign(g.map((w) => keypairOf(w.publicKey))))

      // only the create can be simulated alone: the buys need the coin to exist
      const sim = await api.simulate(built[0].tx).catch(() => null)
      if (sim && !sim.ok) emit("warning", `Create simulation failed: ${JSON.stringify(sim.err)} ${sim.logs.slice(-2).join(" | ")}`)
      else if (sim) emit("simulate", `Create + dev buy simulates (${sim.unitsConsumed ?? "?"} CU, ~${Math.round(built[0].expected.tokens).toLocaleString()} tokens for ${built[0].expected.quoteAmount} ${built[0].quote.symbol})`)

      let landed = false
      try {
        const r = await api.bundle(built.map((b) => b.tx))
        rec.signatures.bundleId = r.bundleId
        emit("bundle", `Bundle accepted by Jito (${r.region}): ${r.bundleId} (POST /api/sol/bundle)`)
        let status = "unknown"
        for (const t0 = Date.now(); Date.now() - t0 < 45_000 && !/^(landed|failed|invalid)$/i.test(status); ) {
          await sleep(2000)
          status = (await api.bundleStatus(r.bundleId).catch(() => ({ status: "unknown" }))).status || "unknown"
        }
        emit("bundle", `Jito bundle status: ${status}`)
        if (await api.waitConfirmed(r.signatures[0], 45_000, (m) => emit("confirm", m))) { createSig = r.signatures[0]; landed = true }
      } catch (e) {
        emit("warning", `Jito refused the bundle: ${e instanceof Error ? e.message : e}`)
      }

      if (landed) {
        emit("confirm", `Create confirmed in the bundle (${createSig!.slice(0, 12)}…)`, { signature: createSig! })
      } else {
        // fallback: the create alone through POST /api/sol/send, then each buyer one by one
        emit("fallback", "Bundle did not land; sending the create on its own, then the buys…")
        const plain = await api.tradeLocal({ ...create, priorityFee: prioritySol })
        plain.tx.sign([devKp, mintKp])
        createSig = (await api.send(plain.tx)).signature
        if (!(await api.waitConfirmed(createSig, 60_000, (m) => emit("confirm", m)))) throw new Error(`Create ${createSig.slice(0, 12)}… not confirmed`)
        emit("confirm", `Create confirmed (${createSig.slice(0, 12)}…)`, { signature: createSig })
        await afterBuys(env, mint, bundle, form, emit, custom, sym, prioritySol, ourWallets(rec))
      }
      if (lookupTable) void closeLut(api, lookupTable, devKp, (m) => emit("lut", m))
    } else {
      // no Jito: create, then buys one by one
      emit("build", `Building the create + dev buy ${form.devBuySol} ${sym} (POST /api/sol/trade-local)`)
      const plain = await api.tradeLocal(create)
      plain.tx.sign([devKp, mintKp])
      createSig = (await api.send(plain.tx)).signature
      if (!(await api.waitConfirmed(createSig, 60_000, (m) => emit("confirm", m)))) throw new Error(`Create ${createSig.slice(0, 12)}… not confirmed`)
      emit("confirm", `Create confirmed (${createSig.slice(0, 12)}…)`, { signature: createSig })
      await afterBuys(env, mint, bundle, form, emit, custom, sym, prioritySol, ourWallets(rec))
    }

    rec.signatures.create = createSig!
    rec.status = "confirmed"
    saveLaunch(rec)
    emit("live", `Live on ${pad.name}: ${padLink(mint)}${plan.mayhem ? " (Mayhem: pump.fun's agent trades it for 24 h)" : ""}`, { mint, signature: createSig!, link: padLink(mint) })

    // after the launch: auto-sell watches the coin while the snipers and holders buy; auto-claim runs on its own
    const stop = { sold: false }
    const selling = form.autoSell && autoSellArmed(form.autoSell) ? autoSell(env, rec, form.autoSell, mint, emit, stop, prioritySol) : null
    if (form.claim && pf.creatorFees) void autoClaim(env, rec, mint, form.claim, emit)
    else if (form.claim) emit("claim", `Auto-claim skipped: ${pad.name} creator fees are not claimable through the API yet`)
    const volumeRun = form.volume && form.volume.wallets.length ? (custom ? (emit("volume", "Volume maker skipped: it runs on SOL coins only"), null) : volumeMaker(env, rec, form.volume, mint, emit, stop, prioritySol)) : null

    // 6. snipers: right now, staggered
    if (snipers.length) {
      emit("snipers", `${snipers.length} sniper buy(s) of ${amounts(snipers, sym)}, ${form.snipers.gapMs} ms apart`)
      rec.signatures.snipers = await sequentialBuys(env, mint, snipers, form.slippage, form.snipers.gapMs, emit, "sniper", custom, sym)
      saveLaunch(rec)
    }

    // 7. holders: after a delay, spread over a window with jitter
    if (holders.length) {
      emit("holders", `${holders.length} holder buy(s) of ${amounts(holders, sym)} after ${form.holders.delayS}s, spread over ${form.holders.windowS}s`)
      const hl = automation(env, rec, mint, { kind: "later", title: "Later buyers", rule: `${holders.length} wallet${holders.length === 1 ? " buys" : "s buy one by one"}, starting ${form.holders.delayS}s after the launch, spread over ${form.holders.windowS}s`, progress: { done: 0, total: holders.length } })
      hl.set({ nextAt: Date.now() + form.holders.delayS * 1000 })
      let going = await hl.sleep(form.holders.delayS * 1000)
      const times = holders.map(() => Math.random() * form.holders.windowS * 1000).sort((a, b) => a - b)
      for (const [i, w] of holders.entries()) {
        const gap = times[i] - (i ? times[i - 1] : 0)
        if (going) { hl.set({ status: "running", nextAt: Date.now() + gap }); going = await hl.sleep(gap) }
        if (!going) { emit("holders", `Later buyers stopped by you: ${holders.length - i} buy(s) not made`); break }
        if (stop.sold) { emit("holders", `Auto-sell has sold: the ${holders.length - i} holder buy(s) still to come are skipped`); break }
        const sig = await oneBuy(env, mint, w, w.amount, form.slippage, emit, "holder", custom, sym)
        if (sig) rec.signatures.holders.push(sig)
        hl.set({ progress: { done: i + 1, total: holders.length } })
      }
      hl.finish(`${hl.a.progress?.done ?? 0} of ${holders.length} bought`)
      saveLaunch(rec)
    }
    if (selling) await selling
    if (volumeRun) await volumeRun
    emit("done", "Launch complete", { mint, link: padLink(mint) })
  } catch (e) {
    rec.status = "error"
    rec.error = e instanceof ApiError ? `${e.message}${e.code ? ` · ${e.code}` : ""}${e.hint ? ` · ${e.hint}` : ""}` : e instanceof Error ? e.message : String(e)
    saveLaunch(rec)
    emit("error", rec.error)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One buy: trade-local → sign → send. Failures are logged, never fatal for the launch. `amount` is in the quote asset. */
async function oneBuy(env: Env, mint: string, w: WalletInfo, amount: number, slippage: number, emit: Emit, stage: string, custom: boolean, sym: string, prioritySol = PRIORITY_FEE_SOL): Promise<string | null> {
  const api = env.api
  try {
    const built = await api.tradeLocal(buyBody(w.publicKey, mint, amount, Math.max(slippage, 20), prioritySol, custom))
    built.tx.sign([env.wallets.keypairOf(w.publicKey)])
    const { signature } = await api.send(built.tx)
    emit(stage, `${w.label} bought ${amount} ${sym} (${signature.slice(0, 12)}…)`, { signature })
    return signature
  } catch (e) {
    emit("warning", `${w.label} buy failed: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

async function sequentialBuys(env: Env, mint: string, wallets: Picked[], slippage: number, gapMs: number, emit: Emit, stage: string, custom: boolean, sym: string): Promise<string[]> {
  const sigs: string[] = []
  for (const [i, w] of wallets.entries()) {
    if (i > 0 && gapMs > 0) await sleep(gapMs)
    const sig = await oneBuy(env, mint, w, w.amount, slippage, emit, stage, custom, sym)
    if (sig) sigs.push(sig)
  }
  return sigs
}

/** Our own wallets on a launch: their trades never count as outside money. */
const ourWallets = (rec: LaunchRecord) => new Set([rec.wallets.dev, ...rec.wallets.bundle, ...rec.wallets.sniper, ...rec.wallets.holder, ...(rec.wallets.volume ?? [])])

/** SOL that wallets other than ours have put into the coin, minus what they took out (GET /api/sol/trades). */
async function outsideNetIn(env: Env, mint: string, ours: Set<string>): Promise<number> {
  const h = await env.api.tradeHistory(mint, 200)
  let net = 0
  for (const t of h.trades) {
    const trader = String(t.traderPublicKey ?? "")
    if (!trader || ours.has(trader)) continue
    const sol = Number(t.solAmount ?? 0)
    if (t.txType === "buy") net += sol
    else if (t.txType === "sell") net -= sol
  }
  return net
}

/** The bundle "right after" the launch: one buy after the other with a random pause, skipping the rest once outsiders put in too much. */
async function afterBuys(env: Env, mint: string, wallets: Picked[], form: LaunchForm, emit: Emit, custom: boolean, sym: string, prioritySol: number, ours: Set<string>): Promise<string[]> {
  const sigs: string[] = []
  const lo = Math.max(0, form.bundleGap?.fromMs ?? 0), hi = Math.max(lo, form.bundleGap?.toMs ?? 0)
  const max = form.bundleMaxOutside ?? 0
  for (const [i, w] of wallets.entries()) {
    if (i > 0 && hi > 0) await sleep(lo + Math.random() * (hi - lo))
    if (max > 0) {
      const net = await outsideNetIn(env, mint, ours).catch(() => 0)
      if (net > max) { emit("bundle", `Outside buyers already put in ${net.toFixed(3)} SOL (limit ${max}): the ${wallets.length - i} bundle buy(s) still to come are skipped`); break }
    }
    const sig = await oneBuy(env, mint, w, w.amount, form.slippage, emit, "bundle", custom, sym, prioritySol)
    if (sig) sigs.push(sig)
  }
  return sigs
}

/**
 * Auto-sell (see AutoSell): check every 3 s, then sell the buyers (all at once or spread) and the main wallet (with them,
 * later, on its own trigger, or not). The two watchers share one outside-money reading, so the API is read once per tick.
 */
async function autoSell(env: Env, rec: LaunchRecord, a: AutoSell, mint: string, emit: Emit, stop: { sold: boolean }, prioritySol: number): Promise<void> {
  const ours = ourWallets(rec)
  const t0 = Date.now()
  let reading: { at: number; net: Promise<number | null> } | null = null
  const netNow = () => {
    if (!reading || Date.now() - reading.at > 2500) reading = { at: Date.now(), net: outsideNetIn(env, mint, ours).catch(() => null) }
    return reading.net
  }
  const rule = (netIn: number, afterMin: number) => [netIn > 0 ? `outside buyers put in ${netIn} SOL` : "", afterMin > 0 ? `${afterMin} min pass` : ""].filter(Boolean).join(" or ")
  /** Resolves with the reason once `netIn` SOL of outside money is in or `afterMin` minutes have passed (0 = that trigger off). */
  const watch = async (netIn: number, afterMin: number, who: string, h: Handle): Promise<string | null> => {
    let lastNote = 0
    for (;;) {
      if (!(await h.sleep(3000))) return null   // Stop was pressed
      if (afterMin > 0 && Date.now() - t0 - h.pausedMs >= afterMin * 60_000) return `${afterMin} min passed`
      if (netIn > 0) {
        const net = await netNow()
        if (h.stopped) return null
        if (net !== null) h.set({ note: `outside buyers ${net >= 0 ? "+" : ""}${net.toFixed(3)} of ${netIn} SOL` })
        if (net !== null && net >= netIn) return `outside buyers put in ${net.toFixed(3)} SOL`
        if (net !== null && Date.now() - lastNote > 30_000) { lastNote = Date.now(); emit("autosell", `Watching (${who}): outside buyers ${net >= 0 ? "+" : ""}${net.toFixed(3)} of ${netIn} SOL`) }
      }
    }
  }
  const buyersArmed = a.netIn > 0 || a.afterMin > 0
  const mainNetIn = a.mainNetIn ?? 0
  const mainAfterMin = a.mainAfterMin ?? 0
  const mainOwn = a.main === "own" && (mainNetIn > 0 || mainAfterMin > 0)
  const hb = buyersArmed ? automation(env, rec, mint, { kind: "autosell", title: "Auto-sell", rule: `${a.main === "with" ? "Every wallet sells" : "The buyer wallets sell"} everything when ${rule(a.netIn, a.afterMin)}`, endsAt: a.afterMin > 0 ? t0 + a.afterMin * 60_000 : undefined }) : null
  const hm = mainOwn ? automation(env, rec, mint, { kind: "autosell-main", title: "Auto-sell · main wallet", rule: `The main wallet sells everything when ${rule(mainNetIn, mainAfterMin)}`, endsAt: mainAfterMin > 0 ? t0 + mainAfterMin * 60_000 : undefined }) : null
  emit("autosell", `Auto-sell armed: ${[buyersArmed ? `buyer wallets sell when ${rule(a.netIn, a.afterMin)}` : "", mainOwn ? `the main wallet sells when ${rule(mainNetIn, mainAfterMin)}` : ""].filter(Boolean).join("; ")}`)

  const sellOne = async (pk: string, who: string) => {
    try {
      const built = await env.api.tradeLocal({ publicKey: pk, action: "sell", mint, amount: "100%", denominatedInQuote: "false", slippage: Math.max(env.slippage, 25), priorityFee: prioritySol, pool: "auto" })
      built.tx.sign([env.wallets.keypairOf(pk)])
      const { signature } = await env.api.send(built.tx)
      emit("autosell", `${who} sold everything (${signature.slice(0, 12)}…)`, { signature })
    } catch (e) {
      emit("warning", `${who} sell failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  const label = (pk: string) => env.wallets.get(pk)?.label ?? pk.slice(0, 8)
  /** All at once, through the shared batch sell (lib/core/sell-all.ts): one slippage that covers the batch's own price
   *  impact, then a second round for any wallet still holding. Only sells that were sent are reported as sold. */
  const sellTogether = async (list: Array<{ pk: string; who: string }>) => {
    const who = new Map(list.map((x) => [x.pk, x.who]))
    const results = await sellAll(env, list.map((x) => x.pk), mint, 100, prioritySol)
    for (const r of results) {
      const name = who.get(r.publicKey) ?? r.publicKey.slice(0, 8)
      if ("signature" in r) emit("autosell", `${name} sold everything${r.retried ? " (second try)" : ""}${r.confirmed ? "" : ", not confirmed yet"} (${r.signature.slice(0, 12)}…)`, { signature: r.signature })
      else if ("error" in r && r.error) emit("warning", `${name} sell failed: ${r.error}`)
    }
  }

  // the main wallet on its own trigger: watched from the launch on, whether the buyers have sold or not
  const mainOwnRun = mainOwn
    ? watch(mainNetIn, mainAfterMin, "main wallet", hm!).then(async (why) => {
        if (why === null) { emit("autosell", "Main wallet auto-sell stopped by you"); hm!.finish("stopped by you"); return }
        hm!.set({ status: "running", note: "selling…" })
        emit("autosell", `Main wallet selling: ${why}`); await sellOne(rec.wallets.dev, "Main wallet")
        hm!.finish(`sold: ${why}`)
      })
    : null

  const why = buyersArmed ? await watch(a.netIn, a.afterMin, "buyers", hb!) : null
  if (buyersArmed && why === null) { emit("autosell", "Auto-sell stopped by you: the buyer wallets keep their coins"); hb!.finish("stopped by you") }
  if (why !== null) {
    stop.sold = true
    hb!.set({ status: "running", note: "selling…" })
    const buyers = [...rec.wallets.bundle, ...rec.wallets.sniper, ...rec.wallets.holder]
    emit("autosell", `Selling: ${why}`)
    const together = a.bundle === "all" || buyers.length < 2
    const main = a.main === "with" && !together ? sellOne(rec.wallets.dev, "Main wallet") : null
    if (together) await sellTogether([...(a.main === "with" ? [{ pk: rec.wallets.dev, who: "Main wallet" }] : []), ...buyers.map((pk) => ({ pk, who: label(pk) }))])
    else {
      const gap = (Math.max(1, a.spreadSec) * 1000) / (buyers.length - 1)
      for (const [i, pk] of buyers.entries()) { if (i) await sleep(gap); await sellOne(pk, label(pk)) }
    }
    await main
    if (a.main === "later") { await sleep(Math.max(1, a.mainLaterSec) * 1000); await sellOne(rec.wallets.dev, "Main wallet") }
    hb!.finish(`sold: ${why}`)
  }
  await mainOwnRun
  emit("autosell", a.main === "keep" ? "Auto-sell done; the main wallet keeps its coins" : "Auto-sell done")
}

/** The volume maker (see Volume): one trade at a time from a random volume wallet, until a stop condition, then they sell out. */
async function volumeMaker(env: Env, rec: LaunchRecord, v: Volume, mint: string, emit: Emit, stop: { sold: boolean }, prioritySol: number): Promise<void> {
  const ws = v.wallets
  const [lo, hi] = VOLUME_PACE[v.pace] ?? VOLUME_PACE.normal
  const size = VOLUME_SIZE[v.size ?? "normal"] ?? VOLUME_SIZE.normal
  const end = Date.now() + Math.max(1, v.minutes) * 60_000
  const hv = automation(env, rec, mint, { kind: "volume", title: "Volume maker", rule: `${ws.length} wallet${ws.length === 1 ? "" : "s"} buy and sell small amounts for up to ${v.minutes} min (${v.pace} pace, ${v.size ?? "normal"} trades)`, endsAt: end })
  hv.set({ status: "running" })
  emit("volume", `Volume maker on (${v.size ?? "normal"} trades): ${ws.length} wallets trade ${v.budget} SOL between them for up to ${v.minutes} min. It stops early when the main wallet sells out or auto-sell fires.`)
  // wild: the direction of the current run and how many trades are left in it
  const run = { dir: "buy" as "buy" | "sell", left: 0 }
  let why = ""
  let trades = 0
  let mainHad = false
  let fails = 0
  while (!why) {
    // a burst (wild): the next trade comes right away
    if (!(await hv.sleep(size.runs && Math.random() < 0.2 ? 300 + Math.random() * 500 : lo + Math.random() * (hi - lo)))) { why = "you stopped it"; break }
    if (stop.sold) { why = "auto-sell fired"; break }
    if (Date.now() >= end + hv.pausedMs) { why = `${v.minutes} min passed`; break }
    const rows = await env.api.balances([rec.wallets.dev, ...ws], mint).catch(() => null)
    if (!rows) continue
    const by = new Map(rows.map((r) => [r.wallet, r]))
    const mainTokens = by.get(rec.wallets.dev)?.token?.balance ?? 0
    if (mainTokens > 0) mainHad = true
    else if (mainHad) { why = "the main wallet sold out"; break }
    const spend = (pk: string) => (by.get(pk)?.sol ?? 0) - GAS_RESERVE
    const held = (pk: string) => by.get(pk)?.token?.balance ?? 0
    if (ws.every((pk) => spend(pk) < 0.005 && held(pk) === 0)) { why = "the volume wallets ran out of SOL"; break }
    let pk = ws[Math.floor(Math.random() * ws.length)]
    let sellIt = held(pk) > 0 && (spend(pk) < 0.005 || Math.random() < size.sellP)
    if (size.runs) {
      // runs: keep going one way, then turn; a wallet that can make the move is picked for it
      if (run.left <= 0) { run.dir = run.dir === "buy" ? "sell" : "buy"; run.left = run.dir === "buy" ? 3 + Math.floor(Math.random() * 4) : 2 + Math.floor(Math.random() * 3) }
      const able = ws.filter((w) => (run.dir === "buy" ? spend(w) >= 0.005 : held(w) > 0))
      if (!able.length) { run.left = 0; continue }
      pk = able[Math.floor(Math.random() * able.length)]
      sellIt = run.dir === "sell"
      run.left--
    }
    if (!sellIt && spend(pk) < 0.005) continue
    try {
      const body = sellIt
        ? { publicKey: pk, action: "sell" as const, mint, amount: `${Math.round(between(size.sell))}%`, denominatedInQuote: "false" as const, slippage: Math.max(env.slippage, 25), priorityFee: prioritySol, pool: "auto" as const }
        : { publicKey: pk, action: "buy" as const, mint, amount: +Math.max(0.005, spend(pk) * between(size.buy)).toFixed(4), denominatedInSol: "true" as const, slippage: Math.max(env.slippage, 25), priorityFee: prioritySol, pool: "auto" as const }
      const built = await env.api.tradeLocal(body)
      built.tx.sign([env.wallets.keypairOf(pk)])
      await env.api.send(built.tx)
      trades++
      hv.set({ note: `${trades} trade${trades === 1 ? "" : "s"} so far` })
      fails = 0
      if (trades % 10 === 0) emit("volume", `Volume maker: ${trades} trades so far`)
    } catch (e) {
      if (++fails >= 5) { why = `5 trades in a row failed (${e instanceof Error ? e.message : e})`; break }
    }
  }
  emit("volume", `Volume maker stopped: ${why} (${trades} trades). The volume wallets now sell what they hold…`)
  const rows = await env.api.balances(ws, mint).catch(() => [])
  await Promise.all(rows.filter((r) => (r.token?.balance ?? 0) > 0).map(async (r) => {
    try {
      const built = await env.api.tradeLocal({ publicKey: r.wallet, action: "sell", mint, amount: "100%", denominatedInQuote: "false", slippage: Math.max(env.slippage, 25), priorityFee: prioritySol, pool: "auto" })
      built.tx.sign([env.wallets.keypairOf(r.wallet)])
      await env.api.send(built.tx)
    } catch (e) {
      emit("warning", `Volume wallet ${r.wallet.slice(0, 8)}… sell failed: ${e instanceof Error ? e.message : e}`)
    }
  }))
  hv.finish(`${why} · ${trades} trade${trades === 1 ? "" : "s"}`, why === "you stopped it" ? "stopped" : "done")
  emit("volume", "Volume wallets sold out. Their SOL stays in them: press Collect all on the Wallets page to bring it back to the main wallet.")
}

/**
 * Auto-claim (see AutoClaim), once. "sold": every 15 s for up to 6 h, read our wallets' balances of the coin; the first
 * time none holds any (after at least one did), claim. "after": wait afterMin minutes, then claim. A failed claim is
 * tried twice more, a minute apart.
 */
async function autoClaim(env: Env, rec: LaunchRecord, mint: string, c: AutoClaim, emit: Emit): Promise<void> {
  const creator = rec.wallets.dev
  const hc = automation(env, rec, mint, { kind: "claim", title: "Auto-claim", rule: c.when === "after" ? `Creator fees are claimed ${c.afterMin} min after the launch` : "Creator fees are claimed once every one of your wallets has sold", endsAt: c.when === "after" ? Date.now() + Math.max(1, c.afterMin) * 60_000 : undefined })
  const over = (result: string) => { hc.finish(result) }
  const stopped = () => { emit("claim", "Auto-claim stopped by you"); over("stopped by you") }
  if (c.when === "after") {
    emit("claim", `Auto-claim on: the creator fees are claimed ${c.afterMin} min after the launch`)
    if (!(await hc.sleep(Math.max(1, c.afterMin) * 60_000))) return stopped()
  } else {
    emit("claim", "Auto-claim on: the creator fees are claimed once every one of your wallets has sold the coin")
    const ours = [...ourWallets(rec)]
    let held = false
    for (const end = Date.now() + 6 * 3600_000; ; ) {
      if (Date.now() > end) { emit("claim", "Auto-claim stopped: your wallets still hold the coin after 6 h. Claim on the Trading page when you are done."); return over("your wallets still held the coin after 6 h") }
      if (!(await hc.sleep(15_000))) return stopped()
      const rows = await env.api.balances(ours, mint).catch(() => null)
      if (!rows) continue
      const any = rows.some((r) => (r.token?.balance ?? 0) > 0)
      if (any) held = true
      else if (held) break
    }
    emit("claim", "Every wallet has sold: claiming the creator fees…")
    hc.set({ status: "running", note: "claiming…" })
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fees = await env.api.creatorFees(creator, mint)
      if (fees.sol <= 0) { emit("claim", "No creator fees to claim"); return over("nothing to claim") }
      const built = await env.api.tradeLocal({ publicKey: creator, action: "collectCreatorFee", mint, priorityFee: 0.0001 })
      built.tx.sign([env.wallets.keypairOf(creator)])
      const { signature } = await env.api.send(built.tx)
      emit("claim", `Claimed ${fees.sol.toFixed(4)} SOL of creator fees into the main wallet (${signature.slice(0, 12)}…)`, { signature })
      return over("claimed")
    } catch (e) {
      emit("warning", `Auto-claim try ${attempt}/3: ${e instanceof Error ? e.message : e}`)
      if (attempt < 3) await sleep(60_000)
    }
  }
  over("the claim failed 3 times")
}

/** One running part of a launch, for the Trading page (lib/automations.ts). Its state goes into the launch record as it changes. */
function automation(env: Env, rec: LaunchRecord, coin: string, init: Omit<Parameters<typeof startAutomation>[0], "launchId" | "coin">): Handle {
  return startAutomation({ launchId: rec.id, coin, ...init }, (a) => {
    const list = (rec.automations ??= [])
    const saved: SavedAutomation = { id: a.id, kind: a.kind, title: a.title, rule: a.rule, status: a.status, result: a.result }
    const i = list.findIndex((x) => x.id === a.id)
    if (i >= 0 && list[i].status === saved.status && list[i].result === saved.result) return
    if (i < 0) list.push(saved); else list[i] = saved
    env.launches.save(rec)
  })
}

/** Where a coin's creator fees go: its creator (our launch record), and `none` when its launchpad pays nothing to claim. */
export function claimTarget(env: Env, mint: string): { creator: string | null; none: string | null } {
  const rec = env.launches.list().find((l) => l.mint === mint)
  const pad = rec?.pad ? padById(rec.pad) : null
  return { creator: rec?.wallets.dev ?? null, none: pad && !padFeatures(pad).creatorFees ? pad.feeNote ?? `${pad.name} pays no creator fees you can claim` : null }
}

/** Deactivate the table now; close it once the chain allows (~4 min, 409 cooling_down before), refunding the rent to the dev. */
async function closeLut(api: Trenchy, lookupTable: string, authority: Keypair, note: (m: string) => void): Promise<void> {
  try {
    const tx = await api.lutStep(lookupTable, "deactivate", authority.publicKey.toBase58())
    tx.sign([authority])
    await api.send(tx)
    note("Lookup table deactivated; closing it in ~4 minutes to refund the rent")
  } catch (e) {
    note(`Lookup table deactivate failed: ${e instanceof Error ? e.message : e}`)
    return
  }
  for (let i = 0; i < 8; i++) {
    await sleep(i === 0 ? 4.5 * 60_000 : 30_000)
    try {
      const tx = await api.lutStep(lookupTable, "close", authority.publicKey.toBase58())
      tx.sign([authority])
      const { signature } = await api.send(tx)
      note(`Lookup table closed, rent refunded (${signature.slice(0, 12)}…)`)
      return
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "cooling_down")) { note(`Lookup table close failed: ${e instanceof Error ? e.message : e}`); return }
    }
  }
}

// ── simulate ────────────────────────────────────────────────────────────────

export type SimulateResult = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }>; plan: Plan; simulation: Simulation | null; expected: Expected | null; quote: Quote }

/**
 * Dry run, nothing is sent: API reachable, funding wallet backed up and holding enough SOL for the plan (and, on a
 * custom pair, every wallet holding its quote asset), then the create + dev buy is built (POST /api/sol/trade-local,
 * funding wallet as creator, a throwaway mint, the form's pair / Mayhem / holder-reward / creator-fee options) and
 * run through POST /api/sol/simulate. The API's answer is returned as is.
 */
export async function simulateLaunch(env: Env, form: LaunchForm): Promise<SimulateResult> {
  const api = env.api
  const checks: SimulateResult["checks"] = []
  const plan = await fundingPlan(env, form)
  const funding = devWallet(env, form)
  if (!funding) throw new Error(form.devWallet ? `Main wallet ${form.devWallet.slice(0, 8)}… is ${notIn(env.wallets, true)}` : "No main wallet yet: create one at the top of the Launch or Wallets page")
  env.wallets.assertBackedUp(funding.publicKey)
  checks.push({ name: "backup", ok: true, detail: `main wallet ${funding.publicKey.slice(0, 8)}… ${env.wallets.backupNote(funding)}` })

  const me = await api.me()
  checks.push({ name: "api", ok: true, detail: `connected to ${api.url} (key ${me.keyPrefix ?? "…"})` })
  const balance = await api.solBalance(funding.publicKey)
  checks.push({ name: "balance", ok: balance >= plan.total, detail: `main wallet holds ${balance.toFixed(4)} SOL, the plan needs ${plan.total.toFixed(4)} SOL${plan.custom ? " (network fees + our fee; the buys are paid in " + plan.quote.symbol + ")" : ""}` })
  if (plan.custom) checks.push({ name: "pair", ok: plan.shortfalls.length === 0, detail: plan.shortfalls.length ? `short of ${plan.quote.symbol}: ${planProblems({ ...plan, refusal: null }).join("; ")}` : `every wallet holds its ${plan.quote.symbol} (${plan.totalQuote} ${plan.quote.symbol} across the plan)` })
  if (plan.refusal) checks.push({ name: "options", ok: false, detail: planProblems({ ...plan, shortfalls: [] })[0] })
  checks.push({ name: "metadata", ok: !!form.metadataUri, detail: form.metadataUri ? `metadata ${form.metadataUri}` : "no metadata URI yet: upload the image first" })
  if (form.useJito && padFeatures(padById(form.launchpad)).sameBlock && groupSize(form.bundle) > MAX_BUNDLE_WALLETS) checks.push({ name: "bundle", ok: false, detail: `at most ${MAX_BUNDLE_WALLETS} bundle buyers in one Jito bundle` })
  // refused options, or a dev wallet short of the quote asset: the build would fail with the same message, so stop here
  if (plan.refusal || plan.shortfalls.some((s) => s.role === "dev")) return { ok: false, checks, plan, simulation: null, expected: null, quote: plan.quote }

  // The simulated create uses a throwaway mint that is never stored or created on chain.
  const pair = await api.resolvePair(form.quoteMint)
  const mintKp = Keypair.generate()
  const built = await api.tradeLocal(createBody({ ...form, name: form.name || "Simulation", symbol: form.symbol || "SIM" }, funding.publicKey, mintKp.publicKey.toBase58(), pair, PRIORITY_FEE_SOL, form.metadataUri || "https://trenchy.tools/simulate.json"))
  built.tx.sign([env.wallets.keypairOf(funding.publicKey), mintKp])
  const simulation = await api.simulate(built.tx)
  checks.push({ name: "simulation", ok: simulation.ok, detail: simulation.ok ? `create + dev buy simulates fine (${simulation.unitsConsumed ?? "?"} CU, ~${Math.round(built.expected.tokens).toLocaleString()} tokens for ${form.devBuySol} ${built.quote.symbol}${built.mayhem?.enabled ? ", Mayhem mode" : ""})` : `simulation failed: ${JSON.stringify(simulation.err)}` })
  return { ok: checks.every((c) => c.ok), checks, plan, simulation, expected: built.expected, quote: built.quote }
}
