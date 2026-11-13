/**
 * THE CHAIN FILE. Everything the pages, cards and "?" texts need to know about the chain lives here: its name, its native
 * coin, how addresses look, where things are seen, the launch's fee and gas numbers, and which extras exist. Client-safe
 * (no node imports). The pages (app/*), the components and lib/help.tsx read this file and never say "SOL" or "pump.fun"
 * themselves, so another chain (the pons starter on Robinhood Chain, any EVM chain) is mostly a new copy of this file.
 * See PORTING.md for the rest (the API client, the launch executor, the signer).
 */
import type { Launchpad } from "./launchpad"

export type ChainConfig = {
  /** the chain, as people say it ("Solana", "Robinhood Chain") */
  name: string
  /** the native coin ("SOL", "ETH") */
  symbol: string
  /** the launchpad people know the coins from ("pump.fun", "pons") */
  launchpad: string
  /** the app's name in the header and the tab title ("pump.fun launcher") */
  appName: string
  /** which product of the TrenchyTools suite this is (an id in lib/suite.ts): the suite bar marks it "you are here" */
  suiteId: string
  /** logos, as paths under public/ (public/logos/ holds Solana, Robinhood, Ethereum, BNB, Base, pump.fun, pons, …) */
  logo: string
  launchpadLogo: string
  /** the block explorer the address and transaction links open */
  explorer: { name: string; logo: string }
  /** the query / body field a coin travels in on this app's routes */
  coinParam: "mint" | "token"
  coinNoun: string
  keyNoun: string
  isAddress: (s: string) => boolean
  isCoin: (s: string) => boolean
  short: (s: string) => string
  /** a native amount for a table cell */
  fmt: (n: number | null | undefined) => string
  /** how many decimals a native amount shows in the cost panel (SOL 4, ETH 5: its amounts are ten times smaller) */
  decimals: number
  explorerAddress: (address: string) => string
  explorerTx: (sig: string) => string
  /** where a coin can be seen: the launchpad, terminals, the explorer; `icon` is the site's logo (public/logos/) */
  coinLinks: (coin: string) => Array<{ label: string; href: string; icon: string }>
  /** GMGN's embeddable candle chart (gmgn.cc is their widget host; gmgn.ai refuses to be framed), or null when the chain has none */
  chartUrl: (coin: string, theme: "dark" | "light") => string | null
  /** the launch-log stream of this app, and one entry of it read into a common shape (the pump.fun and pons routes differ) */
  launchLog: { path: (id: string) => string; read: (e: Record<string, unknown>) => { stage: string; message: string; done: boolean; error: boolean } }
  /** the "Set every amount to" pills, in the native coin */
  pills: string[]
  /** the default of the "Amount each" input (funding) and of a buy */
  defaultEach: string
  defaultBuy: string
  /** Launch page: the dev-buy chips, the buyer-amount chips and the volume maker's default budget, in the native coin */
  devBuyChips: string[]
  buyChips: string[]
  defaultDevBuy: string
  defaultVolumeBudget: string
  /**
   * What every buyer wallet gets on top of its buy. lib/core/launch.ts funds wallets with exactly these, and the cost
   * panel shows them, so they never disagree: the API fee on each buy (0.005 = 0.5 %) and a gas buffer per wallet.
   */
  apiFeeRate: number
  gasBuffer: number
  /**
   * What creating the coin costs the dev wallet on top of its buy: the rent of the coin's new accounts (mint, metadata,
   * curve, token accounts) and the network fees. Counted in the plan, the funding and the cost panel, so a fresh dev
   * wallet keeps its gas buffer for selling later.
   */
  createCost: number
  /** what createCost pays for, in a few words (the cost panel's note) */
  createCostNote: string
  /** The least a wallet must hold to send any trade (the network fee + the priority fee + what the chain keeps in an account). */
  minGas: number
  /** the most bundle buyers one launch can carry */
  maxBundle: number
  /** the tip that carries a same-block bundle ("Jito tip"), or null when the chain has none */
  tipName: string | null
  /** one line on how bundle buyers land, for the "?" of Bundle buyers (limits, lookup tables, …) */
  bundleHelp: string
  /** a vanity address suffix the launchpad uses ("pump"), or null */
  vanitySuffix: string | null
  /**
   * EVM chains only (absent on Solana): where the API serves the chain and what its launchpad needs. The EVM core
   * (lib/trenchy.ts, lib/core/*) reads this, so another EVM chain is mostly a new copy of this file.
   */
  evm?: {
    /** the API prefix: "/api/rh", "/api/bnb", "/api/elysium", "/api/base" */
    api: string
    chainId: number
    /** the API streams this chain's trades on a websocket (wss://…<api>/data); otherwise the app polls GET <api>/trades */
    ws: boolean
    /** the launchpad a create goes to (the API's `venue`) */
    createVenue?: string
    /** the launchpad lets the creator name wallets that skip its launch-window tax (pons, up to 31) */
    exemptList: boolean
    /** the smallest buy the launchpad takes, in the native coin */
    minBuy: number
    /** the coin's supply, for the market cap (price × supply) when the API does not say */
    totalSupply: number
    /** the chain's name on POST /api/transfer (exchange-routed funding) */
    transferChain: string
    /** seconds after the create before any other buy (a launchpad that taxes its first seconds, e.g. Clanker's 20 s anti-snipe) */
    launchQuietS?: number
  }
  /** the launchpads a launch can go to (lib/launchpad.ts); the first is the default */
  launchpads: Launchpad[]
  features: {
    /** Solana: empty token accounts hold rent that "Close empty token accounts" recovers */
    tokenAccounts: boolean
    /** the launchpad pays the creator a share of the trading fees */
    creatorFees: boolean
    /** pump.fun Mayhem coins: a buy past the remaining supply needs `partial fill` */
    mayhem: boolean
    /** bundle buyers can land in the same block as the create ("When: Same block / Right after") */
    sameBlock: boolean
    /** coins can be paired with something other than the native coin (USDC, stocks, …) */
    pairs: boolean
    /** the creator fee can go to the holders instead */
    holderRewards: boolean
  }
}

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const chain: ChainConfig = {
  name: "Solana",
  symbol: "SOL",
  launchpad: "pump.fun",
  appName: "Solana launcher",
  suiteId: "pumpfun",
  logo: "/logos/chains/solana.svg",
  launchpadLogo: "/logos/chains/solana.svg",
  explorer: { name: "Solscan", logo: "/logos/terminals/solscan.png" },
  coinParam: "mint",
  coinNoun: "mint address",
  keyNoun: "base58 secret key",
  isAddress: (s) => ADDR.test(s.trim()),
  isCoin: (s) => ADDR.test(s.trim()),
  short: (s) => (s.length > 11 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s),
  fmt: (n) => (n === null || n === undefined ? "–" : n.toFixed(4)),
  decimals: 4,
  explorerAddress: (a) => `https://solscan.io/account/${a}`,
  explorerTx: (sig) => `https://solscan.io/tx/${sig}`,
  coinLinks: (mint) => [
    { label: "pump.fun", href: `https://pump.fun/coin/${mint}`, icon: "/logos/launchpads/pumpfun.svg" },
    { label: "GMGN", href: `https://gmgn.ai/sol/token/${mint}`, icon: "/logos/terminals/gmgn.png" },
    { label: "DEX Screener", href: `https://dexscreener.com/solana/${mint}`, icon: "/logos/terminals/dexscreener.png" },
    { label: "Solscan", href: `https://solscan.io/token/${mint}`, icon: "/logos/terminals/solscan.png" },
  ],
  // interval=1S: the 1-second candles first (the widget reads `interval` in TradingView form: 1S, 1, 5, 15, 60, 1D)
  chartUrl: (mint, theme) => `https://www.gmgn.cc/kline/sol/${mint}?theme=${theme}&interval=1S`,
  launchLog: {
    path: (id) => `/api/launch/${id}/events`,
    read: (e) => ({ stage: String(e.stage ?? ""), message: String(e.message ?? ""), done: e.stage === "done" || e.stage === "error", error: e.stage === "error" }),
  },
  pills: ["0.01", "0.05", "0.1", "0.5", "1"],
  defaultEach: "0.05",
  defaultBuy: "0.05",
  devBuyChips: ["0.1", "0.25", "0.5", "1", "2"],
  buyChips: ["0.05", "0.1", "0.25", "0.5", "1"],
  defaultDevBuy: "0.5",
  defaultVolumeBudget: "0.5",
  apiFeeRate: 0.005,
  gasBuffer: 0.01,
  // measured: a pump.fun create took ~0.009 SOL (accounts' rent + fees); 0.015 leaves a margin
  createCost: 0.015,
  createCostNote: "account rent + network fees",
  // a sell pays ~0.0005 (priority + network fee) and Solana keeps ~0.0009 in every account: 0.002 is safe
  minGas: 0.002,
  maxBundle: 16,
  tipName: "Jito tip",
  bundleHelp: "With \"Same block\" the launch is one Jito bundle of 5 transactions (the create + 4 buys): up to 4 buyers get a transaction each; from 5 buyers on, a lookup table (an on-chain address list) is created first so 4 buyers fit in each transaction. Its small rent (about 0.02 SOL) is refunded a few minutes after the launch.",
  vanitySuffix: "pump",
  launchpads: [
    { id: "pump", name: "pump.fun", logo: "/logos/launchpads/pumpfun.svg", site: "https://pump.fun", note: "bonding curve → PumpSwap · Jito same-block bundles, vanity …pump, Mayhem, custom pairs, creator fees", body: { venue: "pump" }, coinUrl: (c) => `https://pump.fun/coin/${c}` },
    { id: "stonkfun", name: "StonkFun", logo: "/logos/launchpads/stonkfun.svg", site: "https://www.stonkfun.xyz", note: "Raydium LaunchLab curve (Token-2022) · bundle buys go right after the create · StonkFun sends your creator share as wSOL; Claim unwraps it", body: { venue: "launchlab", platform: "stonkfun" }, coinUrl: (c) => `https://raydium.io/launchpad/token/?mint=${c}`, sameBlock: false, mayhem: false, pairs: false, holderRewards: false, vanitySuffix: null, createCost: 0.02, createCostNote: "pool + metadata rent + network fees" },
    { id: "letsbonk", name: "letsbonk", logo: "/logos/launchpads/letsbonk.svg", site: "https://letsbonk.fun", note: "Raydium LaunchLab curve (1.25 % platform fee) · bundle buys go right after the create", body: { venue: "launchlab", platform: "bonk" }, coinUrl: (c) => `https://letsbonk.fun/token/${c}`, sameBlock: false, mayhem: false, pairs: false, holderRewards: false, vanitySuffix: null, creatorFees: false, feeNote: "letsbonk pays creators nothing (its creator fee is 0 %)", createCost: 0.02, createCostNote: "pool + metadata rent + network fees" },
    { id: "raydium", name: "Raydium", logo: "/logos/launchpads/raydium.png", site: "https://raydium.io/launchpad/", note: "Raydium's own LaunchLab curve (100 SOL raise) · you earn 0.05 % of every trade, claimable, and 10 % of the LP fees after graduation", body: { venue: "launchlab", platform: "raydium" }, coinUrl: (c) => `https://raydium.io/launchpad/token/?mint=${c}`, sameBlock: false, mayhem: false, pairs: false, holderRewards: false, vanitySuffix: null, createCost: 0.02, createCostNote: "pool + metadata rent + network fees" },
  ],
  features: { tokenAccounts: true, creatorFees: true, mayhem: true, sameBlock: true, pairs: true, holderRewards: true },
}
