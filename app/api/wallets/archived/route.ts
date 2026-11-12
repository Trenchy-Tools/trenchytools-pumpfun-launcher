import { fail, ok } from "@/lib/http"
import { serverEnv } from "@/lib/env"
import { listArchived } from "@/lib/wallets"

export const dynamic = "force-dynamic"

/** GET /api/wallets/archived → { wallets: [{ …, native }] }: the archived wallets (files in archived/) with their balance. */
export async function GET() {
  try {
    const list = listArchived()
    const bal = list.length ? await serverEnv().api.balances(list.map((x) => x.publicKey)).catch(() => []) : []
    const by = new Map(bal.map((b) => [b.wallet, b.sol]))
    return ok({ wallets: list.map((x) => ({ ...x, native: by.get(x.publicKey) ?? null })) })
  } catch (e) {
    return fail(e)
  }
}
