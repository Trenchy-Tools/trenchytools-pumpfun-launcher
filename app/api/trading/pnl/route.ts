import { fail, ok } from "@/lib/http"
import { pnl } from "@/lib/trading"

export const dynamic = "force-dynamic"

/** GET /api/trading/pnl?mint=… → the exact profit or loss of every wallet on the coin (GET /api/sol/pnl), and what they still hold. */
export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get("mint")
  if (!mint) return fail(new Error("mint is required"), 400)
  try {
    return ok(await pnl(mint))
  } catch (e) {
    return fail(e)
  }
}
