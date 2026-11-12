# Porting this starter to another chain

This app launches and trades pump.fun coins on Solana. It is built so another chain (an EVM chain such as Robinhood
Chain, Base, BNB, Ethereum) is a **copy of the app with a handful of files changed**. The pages, the wallet screens, the
cost panel, the "?" explanations and every component stay as they are.

The pons starter in this monorepo (`demos/pons-starter`, Robinhood Chain, viem) is a finished EVM example of the same app:
when in doubt, look at how it does a thing.

## The three layers

| Layer | Files | On another chain |
|---|---|---|
| **Words and numbers** | `lib/chain.ts` | Rewrite this one file. |
| **Chain plumbing** | `lib/trenchy.ts`, `lib/core/*.ts`, `lib/browser/signer-*.ts`, `lib/core/wallet-record.ts`, `components/settings-sheet.tsx` | Replace the Solana calls with the chain's. Keep every exported name and shape. |
| **Screens** | `app/*/page.tsx`, `components/*`, `lib/help.tsx`, `lib/api.ts`, `lib/browser/engine.ts`, `app/api/*` | Nothing, apart from the launch form mapping (step 6). |

The rule that keeps this true: **pages never say "SOL", "pump.fun" or "Jito"**. They read `chain.symbol`,
`chain.launchpad`, `chain.tipName`, … from `lib/chain.ts`, and Solana-only sections are shown only when a
`chain.features` flag is on. Keep it that way when you add a screen.

## Step by step

### 1. `lib/chain.ts`: the chain's words, numbers and features

Everything a page or a "?" says about the chain:

- `name`, `symbol`, `launchpad`, `appName`: "Robinhood Chain", "ETH", "pons", "pons starter".
- `coinParam` (`"token"` on EVM), `coinNoun`, `keyNoun` ("0x private key"), `isAddress` / `isCoin` (`/^0x[0-9a-fA-F]{40}$/`), `short`, `fmt`.
- `explorerAddress`, `explorerTx`, `coinLinks`, `chartUrl` (GMGN's chart, or `null`).
- Logos: `logo` (the chain mark), `launchpadLogo`, `explorer` (name + logo) and an `icon` on every `coinLinks` entry. They are paths under `public/logos/`, which already holds Solana, Robinhood, Ethereum, BNB and Base marks, the pump.fun and pons logos, and GMGN, DEX Screener, Solscan and Birdeye icons. Add a file there for anything else (the launcher repo has 158 launchpad icons in `launcher/public/logos/`). Pages show them through `components/ui/brand.tsx` (`BrandIcon`, `IconLink`), never by file name.
- The amounts the screens offer: `pills`, `defaultEach`, `defaultBuy`, `devBuyChips`, `buyChips`, `defaultDevBuy`, `defaultVolumeBudget`. Gas is cheap on most EVM chains, so these are much smaller there (0.001 ETH, not 0.1 SOL).
- **`apiFeeRate` and `gasBuffer`**: what every buyer wallet gets on top of its buy. `lib/core/launch.ts` funds wallets with exactly these numbers and the cost panel shows them, so they cannot drift apart. EVM: a gas buffer around `0.0005`.
- `maxBundle` and `bundleHelp`: how many bundle buyers one launch carries, and the sentence the "?" shows about it.
- `tipName` (`null` where there is no Jito-style tip; the Speed row then only changes the priority fee) and `vanitySuffix` (`null`: the "Coin address" option disappears).
- `features`:
  - `sameBlock`: on EVM there is no Jito bundle; buyers go "right after" the create. With it `false`, the "When" row disappears and the bundle runs the "Right after" path (pause between buys, protection).
  - `pairs`, `mayhem`, `holderRewards`, `tokenAccounts`: pump.fun / Solana only. `false` hides them.
  - `creatorFees`: whether the launchpad pays the creator.

### 2. `lib/core/wallet-record.ts` and `lib/browser/signer-*.ts`: keys

- `CHAIN` ("sol" → "rh", "base", …) and `APP_NAME`: every wallet file and browser record is tagged with them.
- Key generation and signing: Solana uses `Keypair` (`signer-sol.ts`); EVM uses viem accounts (`generatePrivateKey`, `privateKeyToAccount`). The pons starter's `lib/core/evm.ts` has them.
- `lib/browser/keystore.ts` needs no change: it stores whatever key string the signer gives it.
- **Never weaken the backup rule**: a key is written to its file (or downloaded, in demo mode) before anything funds or uses the wallet (`assertBackedUp`).

### 3. `lib/trenchy.ts`: the API client

One method per endpoint, all under `/api/sol/*` today. On EVM chains the API has the same shapes under the chain's
prefix (`/api/rh/*`, …): see https://api.trenchy.tools/openapi.json. The methods the rest of the app calls:

| Method | Solana endpoint | Used by |
|---|---|---|
| `tradeLocal`, `bundleLocal` | `POST /api/sol/trade-local` | launch, trading, auto-sell, volume maker |
| `send`, `waitConfirmed`, `txStatus` | `POST /api/sol/send`, `GET /api/sol/tx/:sig` | everything that sends |
| `balances` | `GET /api/sol/balances` | wallets, trading, volume maker, auto-claim |
| `tradeHistory` | `GET /api/sol/trades` | auto-sell trigger, bundle protection |
| `creatorFees` | `GET /api/sol/creator-fees` | creator fees card, auto-claim |
| `pnl` | `GET /api/sol/pnl` | Profit / loss card (**Solana only for now**; an EVM chain needs the API's equivalent first) |
| `transferSol`, `sendBuilt` | `POST /api/transfer` (route `direct`) | funding, collect, send, top-ups |
| `closeAccounts` | `POST /api/sol/close-accounts` | "Close empty token accounts", Close out |
| `bundle`, `lut*`, `blockhash`, `vanity*`, `pairs` | Solana only | not needed where the feature flag is off |

### 4. `lib/core/launch.ts`: the launch executor

It reads top to bottom: plan → wallets → mint → funding → bundle → snipers → holders, then the after-launch jobs:
`autoSell`, `volumeMaker`, `autoClaim`. Only the transaction-building calls are Solana-specific. On EVM:

- `fundingPlan` / `solRows`: the same rows; the dev row has no tip or lookup-table rent.
- `runLaunch`: create → confirm → buyers with `afterBuys` (pause + protection). The Jito / lookup-table branch goes.
- `autoSell`, `volumeMaker`, `autoClaim`, `outsideNetIn`: chain-neutral logic over `env.api` (trade-local, send, balances, trades, creator fees). Keep them; only their API calls change.
- Keep the `LaunchForm` field names (`devBuySol` and `solEach` are "amount in the native coin" despite the name) so `lib/core/form.ts` and the Launch page need no change.

### 5. `lib/core/trading.ts`, `lib/core/funding.ts`: trading and moving money

`buy`, `sell`, `sellAll`, `creatorFees`, `collectCreatorFees`, `pnl`, `holdings`, `balanceRows`, the live-trade parser,
and the transfers (fund, gather, send, close accounts). Same exported names and return shapes; the API calls change.
"Close empty token accounts" only shows when `chain.features.tokenAccounts` is on.

### 6. The Launch page's form mapping

`app/launch/page.tsx` builds the launch form in one function, `form()`. Solana-only fields (`mint`, `quoteMint`,
`mayhemMode`, `holderReward`, `useJito`) can stay: the EVM executor ignores them. The image upload (`uploadMetadata`)
goes to `POST /api/ipfs` on every chain.

### 7. Settings and the vanity page

- `components/settings-sheet.tsx` has the Jito tip in lamports: on EVM, a gas setting (the pons starter's version).
- `app/vanity` exists for Solana's "…pump" addresses: delete it where `vanitySuffix` is `null`.

## Check your port

```bash
npx tsc --noEmit -p .
```

Then run the app in demo mode and walk it: create the main wallet, add wallets, test a launch ("Test run" sends
nothing), open a coin on Trading.

```bash
NEXT_PUBLIC_DEMO=1 DEMO_MODE=1 npx next dev -p 4852
```

Grep the screens for chain words; it should find only comments:

```bash
grep -rn "\bSOL\b\|pump\.fun\|Jito" app components lib/help.tsx --include=*.tsx | grep -v "^app/api/"
```
