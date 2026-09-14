import { address } from "@solana/kit";

/**
 * The approved EquityGuard deployment on Solana devnet. It is the only place
 * the address is written in TypeScript; tests keep it identical to the Rust
 * `declare_id!` and to `scripts/devnet/devnet.json`. The program is NOT
 * deployed on mainnet.
 */
export const EQUITY_GUARD_DEVNET_PROGRAM_ID = address("EbzHfaoSHdsWuVdatCmmcBnZi5npJBNXmWhFVeEtNnhT");
