import { body, fail, ok, strings } from "@/lib/http"
import { unarchiveWallets } from "@/lib/wallets"

/** POST /api/wallets/unarchive { publicKeys } → move their files back from archived/ into the folder. */
export async function POST(req: Request) {
  const b = await body<{ publicKeys: string[] }>(req)
  const targets = strings(b.publicKeys)
  if (!targets.length) return fail(new Error("publicKeys: at least one wallet"), 400)
  try {
    return ok(unarchiveWallets(targets))
  } catch (e) {
    return fail(e, 409)
  }
}
