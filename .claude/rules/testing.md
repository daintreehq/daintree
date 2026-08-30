---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
  - "**/__tests__/**"
  - "e2e/**"
  - "vitest*.ts"
  - "playwright.config.ts"
---

# Testing

## Unit tests (vitest)

Run the **full** suite before calling work done — `npm test`. Scoped runs have repeatedly hidden failures that then cost a CI round trip; ~153s locally is cheaper than one cycle.

**No jest-dom in this repo.** Only `@testing-library/react` is installed, so `toBeInTheDocument`, `toHaveAttribute` and friends throw "Invalid Chai property". Use plain DOM reads.

**No tautological assertions.** Never assert a value that is a literal copied from the source of truth — `expect(DEFAULT_TIMEOUT).toBe(5000)`, `toHaveClass("text-accent-primary")`. Test computed output, invariants, and conditional logic. If changing the implementation value forces the same edit in the test, delete the test.

Never weaken an assertion to make a change pass. If the intended behaviour changed, change the test deliberately and say so.

Reading a red shard: "Worker exited unexpectedly" **after** every test passed is a known CI flake — rerun it. But a teardown-timer failure whose stack names a new file is a real bug, not a flake.

`vitest.setup.ts` redirects `DAINTREE_USER_DATA` to a temp dir and primes the Radix loader — tests that build a git factory or render Radix depend on it.

Integration tests have their own config: `npm run test:integration`.

## E2E (Playwright)

**Never decide to run E2E yourself.** Local runs are slow and lock up the machine. Run only the spec or bucket the user names, only when they ask, and never as part of a merge. Full cross-platform validation goes through the `stabilize` workflow, not a local sweep.

E2E runs against the **built** app — `npm run build:e2e` first. A failed build leaves the previous bundle in place and the suite happily tests code you did not write.

Twelve Playwright projects:

- `core` — release smoke.
- `full-terminal`, `full-worktree`, `full-presets`, `full-platform`, `full-panels`, `full-resilience`, `full-plugins` — the seven feature buckets, auto-sharded 4× in CI.
- `online` — real-API agent tests; gates releases.
- `nightly` — memory-leak detection.
- `screenshots` — marketing and theme-tour capture (`npm run theme:tour`).
- `demo` — demo-video recording.

Run one: `npx playwright test <spec>` or `npm run test:e2e:full-terminal`. Remotely: `gh workflow run "E2E Tests" --ref develop -f platform=linux -f suite=full-terminal -f test_file=<spec>`, or `e2e-single.yml` for a single test.

Bucket boundaries: `docs/e2e-testing.md`.

Freeze behaviour is unobservable under Playwright's focus emulation — use `npm run test:freeze-harness` instead.

## What CI actually runs

On PRs and pushes: `npm run check`, vitest in 4 shards, and build + preload-backdoor check + smoke — Ubuntu only, no E2E. `ci-ok` is the sole required check.

Budget and perf scripts are intentionally out of CI pre-1.0 (dormancy note in `ci.yml`). `test-ratio` runs on PRs but is informational and always exits 0.

Cron workflows exist for `test-ratio`, `performance`, `pattern-discovery` and `stale-quarantine`. What must **not** come back is a cron **E2E/nightly test** run that opens issues — that was deliberately replaced by the on-demand `stabilize` workflow. `nightly-publish.yml` is a build/publish job for the nightly update channel, not a test run.
