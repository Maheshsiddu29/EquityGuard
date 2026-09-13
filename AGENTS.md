# AGENTS.md

Operating rules for Claude Code and any other coding agent working in this
repository. These rules override agent defaults.

## 1. Project purpose

EquityGuard is corporate-action-aware execution infrastructure for tokenized
equities on Solana — "slippage protection, but for corporate actions."

A tokenized equity's economic state (ScaledUiAmount multiplier, pending
multiplier, activation timestamp, issuer pause) can change between quote time,
wallet signing, and transaction landing. EquityGuard moves the critical check
into execution time: a guard instruction placed in the same transaction as the
trade fails atomically if the protected state no longer matches what the client
expected.

Primary users are venues, wallets, aggregators, trading applications, agents and
DeFi protocols integrating tokenized equities. It is not primarily a retail app.

## 2. Scope freeze

Build, in this order:

1. one Solana guard program
2. Token-2022 ScaledUiAmount state decoding
3. devnet test mints
4. read-only mainnet corporate-action watcher
5. xStocks adapter (Ondo only after xStocks works end-to-end)
6. representation-state normalization
7. Jupiter transaction composition
8. rerouting, only after the base guard works
9. thin demo UI

Do not build: EquityIntent, solver networks, generalized intent schemas,
generalized SDKs, ZK, lending, borrowing, DAOs, tokens, microservices, Kafka,
Kubernetes, a database (unless a real persistence requirement appears),
speculative abstraction layers, or enterprise theatre.

Scope changes require explicit human approval.

## 3. Architecture principles

- Smallest instruction surface that proves the invariant. No generic APIs.
- Compare deterministic integer/byte representations on-chain. Never base a
  safety decision on floating-point equality.
- Issuer-native raw state is kept separate from the normalized state model
  (`SAFE`, `TRANSITION`, `PAUSED`, `UNKNOWN`). `UNKNOWN` fails closed.
- xStocks and Ondo are independent adapters. Do not assume shared semantics.
- Only create directories and packages justified by real code.
- Small modules, explicit errors, no `unwrap`/`expect` in production paths
  unless logically impossible and justified in a comment.
- Rustdoc on public interfaces; comments explain why, not syntax.
- Strict TypeScript, no uncontrolled `any`, typed configuration, structured
  errors, clear RPC boundaries.
- No secrets, private RPC URLs, or magic constants in source. Configuration via
  environment variables.
- Architecture docs in `docs/` are updated in the same change as the code they
  describe.

## 4. Testing requirements

Tests are part of the implementation. A feature is not done without tests that
exercise its failure modes. Required coverage as components land:

- safe / unchanged snapshot → succeeds
- current multiplier, pending multiplier, or effective timestamp changed → fails
- activation crossing the safety boundary → fails when appropriate
- unknown or malformed state → fails closed
- unsupported mint or extension → clear error
- ScaledUiAmount UI conversions never rely on exact float round-trips
- invalid test-mint extension combinations (e.g. ScaledUiAmount +
  InterestBearingConfig) are rejected
- downstream execution does not settle when the guard fails (atomicity)

No coverage-only tests. Fixtures must be deterministic.

## 5. Git rules

Allowed: inspect status/log/diff, edit local files, `git add`, local commits.

Forbidden: `git push` (any form), force push, merging, creating pull requests
(`gh pr create` or otherwise), publishing releases or packages, modifying
GitHub repository settings, modifying or removing the `origin` remote,
rewriting already-reviewed history, publishing anything externally.

Commits are meaningful engineering units with conventional prefixes (`feat:`,
`fix:`, `test:`, `docs:`, `chore:`, `ci:`). No giant commits, no fake
micro-commits. Never commit generated evidence data (`evidence/*.jsonl`,
`evidence/*.log`).

## 6. Mandatory human review gate

Work proceeds milestone by milestone. At the end of each milestone the agent
must stop and report: files changed, decisions made, commands run, test/lint/
build results, local commit hashes, `git status`, missing tooling, assumptions
needing approval, and the proposed next milestone. The agent then waits for
explicit human approval before starting the next milestone.

## 7. Never-push rule

**Claude Code and other coding agents MUST NEVER push, merge, publish, create
PRs, or modify remote repository state. Local commits are allowed. The human
owner performs all pushes.**

## 8. Mainnet/devnet honesty requirement

- The UI area labelled **LIVE MAINNET** is read-only and shows only real,
  current on-chain or issuer data. Nothing simulated, replayed or engineered may
  appear there.
- The **DEVNET EXECUTION** area uses controlled Token-2022 test mints with
  engineered transitions and real signed transactions against the deployed
  program.
- The seam between the two is disclosed explicitly in the demo. See
  `docs/demo-boundary.md`.
- Never claim a devnet or mainnet proof demonstrates a real corporate action
  unless the asset genuinely underwent one.
- Never claim different issuers' representations are legally or economically
  identical.

## 9. Security and invariant expectations

The core invariant (`docs/invariants.md`):

> A transaction constructed against economic state S must not execute
> successfully if the relevant protected economic state has changed to S'
> before execution.

- The guard validates the mint account's owner is Token-2022 and fails closed on
  any unparseable or unsupported state.
- Rerouting across issuers never happens silently; it requires explicit user
  consent and full disclosure of issuers, reason, and cost/quote differences.
- EquityGuard protects the discrete corporate-action transition. It does not
  guarantee post-transition AMM fair value; ordinary slippage controls remain
  responsible for that. See `docs/threat-model.md`.

## 10. Definition of done

A change is done when:

- it stays within the scope freeze;
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test`, `cargo build-sbf` and the LiteSVM tests against the built
  program pass, plus the equivalent TypeScript/JS checks for code that exists.
  Validation that could not run is reported as blocked, never as passed;
- failure-mode tests exist for new behaviour;
- relevant docs in `docs/` reflect the implementation;
- no secrets, generated evidence, or dead code is committed;
- changes are committed locally in meaningful units — and not pushed;
- the milestone report has been delivered and the human has approved.
