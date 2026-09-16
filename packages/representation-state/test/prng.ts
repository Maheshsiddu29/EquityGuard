/**
 * Deterministic xorshift64* for property tests, mirroring
 * `programs/equity_guard/tests/common/mod.rs`.
 *
 * Not cryptographic: it only has to be stable so a failing case reproduces
 * from its seed and index, in CI and locally alike.
 */

const MASK = (1n << 64n) - 1n;
const MULTIPLIER = 0x2545_f491_4f6c_dd1dn;

export class Prng {
  #state: bigint;

  constructor(seed: bigint) {
    if (seed === 0n) throw new RangeError("xorshift needs a non-zero seed");
    this.#state = seed & MASK;
  }

  nextU64(): bigint {
    let x = this.#state;
    x ^= x >> 12n;
    x = (x ^ (x << 25n)) & MASK;
    x ^= x >> 27n;
    this.#state = x;
    return (x * MULTIPLIER) & MASK;
  }

  /** A value in `[0, bound)`. */
  below(bound: number): number {
    if (bound <= 0) throw new RangeError("bound must be positive");
    return Number(this.nextU64() % BigInt(bound));
  }

  /** A bigint in `[0, bound)`. */
  belowBig(bound: bigint): bigint {
    if (bound <= 0n) throw new RangeError("bound must be positive");
    return this.nextU64() % bound;
  }

  pick<T>(options: readonly T[]): T {
    return options[this.below(options.length)] as T;
  }

  chance(oneIn: number): boolean {
    return this.below(oneIn) === 0;
  }
}

/** One seed for every property suite, so failures are quotable. */
export const PROPERTY_SEED = 0x9c_2026_0ffn;
