# ADR 0001: Minimal execution-time guard

- Status: accepted (Milestone 1)
- Date: 2026-09-13

## Context

Tokenized equities on Solana (xStocks, Ondo) encode corporate actions through
Token-2022 state such as the ScaledUiAmount extension (current multiplier, new
multiplier, effective timestamp) and issuer pauses. Clients check this state
off-chain, but it can change between check time and landing. We need to prove
one invariant for Stocklana 2026 without building general intent or routing
infrastructure.

## Decision

1. **One program, one instruction.** `assert_safe_execution(expected)` reads the
   supplied Token-2022 mint and fails if protected state differs from
   `expected` or execution falls within a protection window. No generic
   predicate language, no config accounts, no PDAs, no writes.
2. **Native Rust program, no Anchor.** The program has one read-only account and
   fixed-size data. Anchor's account validation, discriminators and IDL add
   dependency weight and per-instruction overhead that this surface does not
   need. We use the modular Solana crates (`solana-program-entrypoint`,
   `solana-account-info`, `solana-program-error`) and, from Milestone 2,
   `spl-token-2022-interface` for extension parsing. A TypeScript instruction
   builder is small enough to hand-write and test against the program.
3. **Byte equality for protected state.** Multipliers are compared by stored
   representation, never float equality.
4. **Clock via sysvar getter.** No clock account is passed.
5. **Fail closed.** Every unrecognised condition is an error.
6. **Atomicity supplies enforcement.** The guard precedes execution
   instructions in the same transaction; its failure reverts everything.
7. **Test with LiteSVM** against the compiled program, including a downstream
   instruction to prove atomic non-settlement (done in Milestone 2).

Clock handling was refined in
[ADR 0002](0002-clock-aware-transition-protection.md).

## Consequences

- Very low composition overhead with Jupiter transactions.
- No IDL generated automatically; the instruction layout is documented and
  covered by tests on both sides.
- The guard cannot tell whether the downstream swap trades the guarded mint;
  the composer must bind them (see threat model T4/T5).
- Adding issuer-specific checks (e.g. Ondo pause semantics) means extending
  expected-state fields deliberately, via a new ADR, not a generic API.

## Alternatives considered

- **Anchor:** faster scaffolding and IDL, rejected for overhead and dependency
  surface relative to a single read-only instruction. Revisit if the
  instruction set grows.
- **Pinocchio:** minimal and fast, but less mainstream tooling for
  Token-2022 extension parsing; revisit if compute/size becomes a constraint.
- **Off-chain check only:** does not satisfy I-1; rejected.
- **Transaction introspection (instructions sysvar) to verify the swap:**
  more protection, more complexity and accounts; deferred.
