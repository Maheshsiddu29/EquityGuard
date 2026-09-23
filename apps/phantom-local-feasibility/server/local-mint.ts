import { getAddressEncoder, type Address } from "@solana/kit";
import { decodeProtectedState, TOKEN_2022_PROGRAM_ADDRESS } from "../../../packages/guard-client/src/index.ts";

/** Only the derived validator fixture is edited; captured source bytes are never written. */
export function deriveLocalMint(source: Uint8Array, authority: Address, parkedT: bigint): Uint8Array {
  decodeProtectedState(TOKEN_2022_PROGRAM_ADDRESS, source);
  const bytes = Uint8Array.from(source);
  const view = new DataView(bytes.buffer);
  for (let offset = 166; offset + 4 <= bytes.length;) {
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (type === 25 && length === 56) {
      bytes.set(getAddressEncoder().encode(authority), offset + 4);
      view.setBigInt64(offset + 44, parkedT, true);
      return bytes;
    }
    if (type === 0 || offset + 4 + length > bytes.length) break;
    offset += 4 + length;
  }
  throw new Error("Captured mint has no valid ScaledUiAmount configuration");
}
