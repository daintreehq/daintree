# Contributing to Daintree

Thanks for your interest in contributing. Daintree is an Electron-based workspace for orchestrating AI coding agents, and we welcome bug fixes, features, tests, and docs from the community.

This document is the rulebook. If something here is unclear or seems wrong, open an issue — the contribution guide is code too.

## Code of Conduct

Be kind, be specific, assume good faith. Harassment, personal attacks, and bad-faith engagement will get you removed from the project. When in doubt, err on the side of generosity.

## Getting set up

```bash
git clone https://github.com/canopyide/canopy.git
cd daintree
npm install        # runs the postinstall rebuild for node-pty
npm run dev        # Main + Renderer with HMR
```

A few things worth knowing up front:

- **Node version:** match the version in `.nvmrc` if present, otherwise Node 20+.
- **Native modules:** `node-pty` must be rebuilt against Electron's ABI. The `postinstall` hook does this for you. If you hit errors, run `npm run rebuild`.
- **Don't use `--ignore-scripts`** during install — it skips the native rebuild and the app will crash on startup.
- **`npm ci`** is fine for clean/CI builds. For day-to-day dev, `npm install` is preferred.

Useful scripts:

```bash
npm run check      # typecheck + lint + format — must be clean before pushing
npm run fix        # auto-fix lint and format issues
npm run build      # production build
npm run package    # build distributables
npm run rebuild    # rebuild native modules against Electron
```

## Branching model

Daintree uses **Gitflow**.

- **All PRs target `develop`.** Never open a PR against `main`. `main` only receives merges from release branches.
- Branch naming: `feat/short-description`, `fix/issue-1234-short-description`, `refactor/...`, `docs/...`, `test/...`.
- Keep branches focused. One logical change per branch. If you find yourself writing "and also…" in the PR description, split it.

## Before you start work

1. **Find or file an issue.** For anything non-trivial, there should be an issue describing the problem or feature before code is written. This gives us a chance to catch scope or design problems early.
2. **Leave a comment** on the issue saying you're picking it up, so we don't duplicate work.
3. **Skip `human-review` issues.** These require a developer observing runtime behavior or making subjective UX calls. They're explicitly not suitable for outside contributions without coordination.
4. **Check the `docs/` folder** for relevant architecture notes before diving in — `docs/development.md` is a good starting point.

## Commit messages

We use **[Conventional Commits](https://www.conventionalcommits.org/)** with a scope. The format is:

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`, `style`.

**Scopes** are domain-specific and should match the area of the codebase you're touching — look at recent commits on `develop` for examples. Common ones: `ipc`, `terminal`, `pty`, `theme`, `setup`, `agents`, `worktree`, `ui`, `hydration`, `bulk`, `e2e`.

Good examples (pulled from actual commits):

```
fix(ipc): replace sliding-window rate limiter with leaky bucket for worktree creation
feat(theme): accent colour override for themes
refactor(toolbar): derive agent buttons dynamically from BUILT_IN_AGENT_IDS
test(demo): replace fixed timeout with vi.waitFor in DemoCursor test
```

Keep the summary under ~70 characters. Write in the imperative mood ("add", not "added"). If you need more context, put it in the commit body, separated by a blank line.

## Pull requests

### PR title

Same format as commit messages — `type(scope): summary`, under 70 characters. This becomes the merge commit subject, so make it count.

### PR description

Every PR must use this three-section template:

```markdown
## Summary

- 1–3 bullets explaining _what_ changed and _why_. Lead with the user-visible behavior or the root cause, not the mechanical diff.

Resolves #<issue-number>

## Changes

- `path/to/file.ts`: what you changed and why, in one line
- `path/to/other.ts`: ditto
- `path/to/__tests__/file.test.ts`: what the new tests cover

## Testing

- What you ran locally and what it verified
- Any unit/integration/E2E coverage you added
- Anything you _couldn't_ test and why (be honest — "verified in CI" is fine)
```

Real examples of this format are plentiful in the merged PR history (e.g. canopyide/canopy#5106, canopyide/canopy#5102, canopyide/canopy#5092) — read a few before opening yours.

Rules:

- **Always include `Resolves #N`** (or `Fixes #N`) so the issue auto-closes on merge.
- **One PR, one concern.** Refactors, features, and fixes don't share PRs. If your bug fix uncovers a needed refactor, land the refactor first.
- **Don't amend history after review starts.** Add new commits; squash happens at merge.
- **Draft PRs** are encouraged for early feedback — mark them ready when CI is green.

## Testing requirements

**This is not optional.** The bar for merging is:

1. **Unit tests for every change.** New features need tests. Bug fixes need a **regression test** that reproduces the original bug and fails without your fix. "I tested it manually" does not count.
2. **`npm run check` is clean.** Zero typecheck errors, zero new lint errors, formatted. The lint ratchet only moves one direction.
3. **All existing tests pass.** If a test breaks because of your change, update it deliberately and explain why in the PR. Don't delete tests to make them pass.
4. **E2E tests when touching covered features.** If you modify a feature that has an existing E2E test under `e2e/core/`, `e2e/full/`, or `e2e/online/`, run that test locally before pushing:
   ```bash
   npx playwright test e2e/core/core-foo.spec.ts
   ```
   New E2E tests should default to `e2e/core/` only if they gate releases — otherwise `e2e/full/`.
5. **No mocks at the seam you're fixing.** If the bug is in IPC, test against a real IPC round-trip. If it's in PTY spawn, test against a real spawn. Mocks are for dependencies of the code under test, not for the code under test itself.

Tests live in `__tests__/` folders next to the code they cover. Vitest for unit/integration, Playwright for E2E.

## Code style

Daintree optimizes for **high signal-to-noise**. Code should be obvious enough that it doesn't need narration.

- **Minimal comments.** Comment _why_, not _what_. Don't write docstrings for self-evident functions. No decorative headers or banner comments.
- **No `any`.** Use `unknown` and narrow, or define the real type. If you genuinely need `any`, leave a comment explaining why.
- **Small, focused functions.** If a function needs a section header inside it, it probably wants to be two functions.
- **Don't add speculative abstractions.** Three similar lines is better than a premature helper. Build the abstraction when the third caller actually exists.
- **Don't expand scope.** A bug fix shouldn't clean up surrounding code. A feature PR shouldn't reformat adjacent files. Keep diffs reviewable.
- **No emojis in code or commits** unless explicitly requested.

Formatting is handled by Prettier and ESLint — don't hand-format. Run `npm run fix` before pushing.

## Electron specifics

Daintree is a multi-process Electron app. A few things that will get a PR rejected on first pass if you miss them:

- **Renderer has no Node access.** All native/system calls go through the preload bridge (`electron/preload.cts`) using `contextBridge.exposeInMainWorld`. Don't enable `nodeIntegration`. Don't use the deprecated `remote` module.
- **IPC is typed end-to-end.** New channels go in `electron/ipc/channels.ts`, handlers in `electron/ipc/handlers/<domain>.ts`, preload exposure in `electron/preload.cts`, and renderer types in `src/types/electron.d.ts`. Skipping any layer breaks the build.
- **Main vs renderer boundary matters.** Services that touch `node-pty`, `simple-git`, or the filesystem belong in `electron/services/`. React, Zustand, and xterm belong in `src/`. Shared types go in `shared/`.
- **Version pinning is load-bearing.** Daintree is on **Electron 41**, **@xterm/xterm 6.0**, **@xterm/addon-fit 0.11**, and **React 19**. There are real breaking changes between these and older versions — research against the correct version when reading docs or advice.
- **Actions go through `ActionService`.** If you're adding a user-facing operation, add it to `shared/types/actions.ts` and create a definition in `src/services/actions/definitions/`. Don't wire menus or keybindings to raw handlers.

## Review etiquette

### If you're the author

- Respond to review comments within a reasonable window. Stale PRs get closed.
- Push fixes as new commits during review; we squash at merge.
- If you disagree with a comment, say so — but bring a reason, not just a preference.

### If you're reviewing

- **Prefix minor style comments with `nit:`** so the author knows they're optional.
- **Prefix blockers with `blocker:`** so there's no ambiguity about what stops merge.
- **One round-trip target: 48–72 hours.** If you can't get to a PR in that window, say so in a comment so the author can seek another reviewer.
- **Approve when it's good enough, not when it's perfect.** Ship small, iterate.
- **Security-sensitive changes** (IPC surface, preload bridge, `shell.openExternal`, file system writes, network fetches) warrant an extra pass. Flag them.

## Releases

Releases are cut from `develop` into a release branch, tagged, and merged to `main` by maintainers. Contributors don't need to do anything here — see `docs/release.md` if you're curious about the process.

## Questions

- **Found a bug?** Open an issue with a reproduction.
- **Have a feature idea?** Open an issue describing the problem first, not the solution.
- **Not sure if something belongs in Daintree?** See `docs/feature-curation.md`, then ask on the issue.
- **Stuck on something in this guide?** Open an issue tagged `docs` and we'll fix the guide.

Thanks for contributing.
