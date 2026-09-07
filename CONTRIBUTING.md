# Contributing to Daintree

Thanks for your interest in contributing.

**A well-researched issue is the most valuable thing you can send.** Not a placeholder, not a feature wish: a report that says what's broken or missing, where in the code it lives, what you already ruled out, and what decision is actually open. That's the contribution this project wants most, and here it's worth more than a patch.

That's a workflow claim, not a courtesy. Issues get run through an AI development pipeline that takes a report end to end (research, plan, implementation, tests, review) and validates the whole path in one pass, with a human checking it at the same time. Implementation stopped being the expensive part a while ago. Knowing precisely what is wrong, which invariant it sits behind, and which calls are still open: that's the part that's still hard, and that's the part a good issue does.

**Pull requests are welcome, with one thing worth knowing up front.** A PR usually gets treated as a starting point rather than the finished article. What lands tends to be your change plus a fair amount built on top: edge cases, tests, the adjacent surfaces that had the same bug, the design details that only become visible once the code exists. That's not a verdict on what you sent. It's how work ships here, including work written in-house. You get credited on whatever lands, with `Co-authored-by:` on the commit and a link back to your PR if it's superseded rather than merged directly. If having your patch reworked would bother you, file the issue instead and let the pipeline take it.

**The exception is a real one: if you've validated and verified everything in your PR yourself, it's more than fine exactly as it stands.** That means tests that fail without your change, the full suite green locally, `npm run check` clean, the edge cases actually exercised, and an honest note about anything you couldn't test. A PR that clears that bar is the whole job done, and it gets treated as the whole job. The [testing requirements](#testing-requirements) below are that bar, spelled out.

Use whatever tools you like to get there, coding agents included: that's what Daintree is for. You own every line you send regardless of what wrote it, and "the agent did it" isn't an answer to a review comment on a diff you can't explain.

If something here is unclear, open an issue. The contribution guide is code too.

## Filing a good issue

One problem per issue. If you're writing "and also", it's two issues. No umbrella issues that collect five loosely related things — they can't be worked, only re-read.

What a good issue does:

- **Leads with observed behaviour, not your proposed fix.** What you did, what happened, what you expected. If you have a fix in mind, it goes at the end, clearly marked as your suggestion.
- **Cites the code.** `electron/services/mcp-server/resourceOwnership.ts:42` beats "somewhere in the MCP server". If you traced the mechanism, say what it is. If you're guessing, say you're guessing — a labelled guess is useful, a guess dressed as a finding costs a round trip.
- **Says what you ruled out.** The paths you checked and eliminated are often the most valuable paragraph in the report, because they're the ones nobody else has to walk again.
- **Separates the invariant from the request.** If the current behaviour is deliberate, say so and design around it. "This is intentional and here's why, but it costs X" is a far stronger issue than "this is broken".
- **Lists the open decisions.** Name the calls that aren't yours to make — surface shape, tier, scope, what's in and what's out — and give your recommendation for each. That's what turns a report into something that can be executed without a conversation.
- **Includes a reproduction.** Daintree version, OS, steps. Which agent CLI, if it's agent-related. A repro that actually fails is worth more than a paragraph describing one.
- **Corrects itself in the open.** If you find out your premise was wrong, rewrite the body, retitle it, and say what changed. That's a good issue getting better, and it's welcome.

What doesn't help: a title with no body, "would be nice if", a stack of feature requests in one thread, screenshots with no context, or a support question filed as a bug. If you're not sure whether something belongs in Daintree at all, read `docs/feature-curation.md` first — it's the rubric for what deliberately doesn't get built.

Two labels to know about:

- **`human-review`** — needs a developer watching runtime behaviour or making a subjective UX call. Not suitable for outside implementation without coordination.
- **`monitoring`** — blocked on something external (an upstream release, a spec landing, a dependency fix). Checkable, not workable.

## License

Contributions to Daintree are licensed under the [Apache License 2.0](LICENSE), the same license as the rest of the project. You retain copyright in your contributions. The Daintree name and logo are not covered by that license — see [TRADEMARKS.md](TRADEMARKS.md).

## Code of Conduct

Be kind, be specific, assume good faith. Harassment, personal attacks, and bad-faith engagement will get you removed from the project. When in doubt, err on the side of generosity.

## Getting set up

```bash
git clone https://github.com/daintreehq/daintree.git
cd daintree
npm install        # runs the postinstall rebuild for node-pty
npm run dev        # Main + Renderer with HMR
```

A few things worth knowing up front:

- **Node version:** use the exact version pinned in `.nvmrc` — it's kept in sync with `.node-version` and `package.json`'s `engines.node` floor (`npm run check` enforces this).
- **Native modules:** `node-pty` must be rebuilt against Electron's ABI. The `postinstall` hook does this for you. If you hit errors, run `npm run rebuild`.
- **Don't use `--ignore-scripts`** during install — it skips the native rebuild and the app will crash on startup.
- **`npm ci`** is fine for clean/CI builds. For day-to-day dev, `npm install` is preferred.

Useful scripts:

```bash
npm test           # vitest — the full suite; scoped runs miss things
npm run check      # typecheck + codegen/guard checks + lint ratchet + format check
npm run fix        # auto-fix lint and format issues (repo-wide — see below)
npm run build      # production build
npm run package    # build distributables
npm run rebuild    # rebuild native modules against Electron
```

`npm run fix` reformats and auto-fixes across the whole repo, including files you never touched. If your PR needs to stay scoped, fix your own files by hand.

## Demo development

Demo authoring — the Stage DSL, scene runner, and recording pipeline — lives in a separate repo: [`daintreehq/demo-studio`](https://github.com/daintreehq/demo-studio). Clone it into the `demo/` directory at the root of this repo:

```bash
git clone https://github.com/daintreehq/demo-studio.git demo
```

`demo/` is gitignored here and excluded from packaged builds, so the clone won't pollute `git status` or ship in releases. The app-side surface demo-studio drives (the `--demo-mode` flag, IPC handlers, and `DemoCursor`/`DemoOverlay` components) lives in this repo and is maintained here. See the demo-studio README for authoring workflow.

## Branching model

Daintree uses **Gitflow**.

- **All PRs target `develop`.** Never open a PR against `main`. `main` only receives merges from release branches.
- Branch naming: `feat/short-description`, `fix/issue-1234-short-description`, `refactor/...`, `docs/...`, `test/...`.
- Keep branches focused. One logical change per branch. If you find yourself writing "and also…" in the PR description, split it.

## Before you write code

1. **File the issue first**, to the bar above. For anything non-trivial the issue comes before the code, so scope and design problems surface while they're still cheap.
2. **Say you're picking it up** in a comment, so nobody duplicates work.
3. **Agree the shape before building anything large.** Small, self-evident fixes can just go. For anything with a design decision in it, settle that on the issue first — it's the cheapest place to find out the shape is wrong. Tick "Allow edits by maintainers" on the PR so the branch can be built on directly.
4. **Skip `human-review` issues.** They need a developer observing runtime behaviour or making a subjective UX call.
5. **Read the relevant `docs/`** before diving in — `docs/development.md` is a good starting point.

## Commit messages

We use **[Conventional Commits](https://www.conventionalcommits.org/)** with a scope. The format is:

```
<type>(<scope>): <short summary>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`, `style`.

**Scopes** are domain-specific and should match the area of the codebase you're touching — look at recent commits on `develop` for examples. Common ones: `ipc`, `terminal`, `pty`, `theme`, `setup`, `agents`, `worktree`, `ui`, `mcp`, `plugins`, `e2e`.

Good examples (pulled from actual commits):

```
fix(ipc): replace sliding-window rate limiter with leaky bucket for worktree creation
feat(theme): accent colour override for themes
refactor(toolbar): derive agent buttons dynamically from BUILT_IN_AGENT_IDS
test(demo): replace fixed timeout with vi.waitFor in DemoCursor test
```

Keep the summary under ~70 characters. Write in the imperative mood ("add", not "added"). If you need more context, put it in the commit body, separated by a blank line.

## Pull requests

The **Testing** section of your PR description is the one that decides how the PR gets handled. Say plainly what you ran and what you verified, and a PR that clears the bar below can go in as it stands. Leave it thin and the change gets treated as a starting point and built on.

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

Real examples of this format are plentiful in the merged PR history — read a few before opening yours.

Rules:

- **Always include `Resolves #N`** (or `Fixes #N`) so the issue auto-closes on merge.
- **One PR, one concern.** Refactors, features, and fixes don't share PRs. If your bug fix uncovers a needed refactor, land the refactor first.
- **Don't amend history after review starts.** Add new commits; squash happens at merge.
- **Draft PRs** are encouraged for early feedback — mark them ready when CI is green.
- **Leave "Allow edits by maintainers" on.** It's how extra work lands on your branch instead of in a PR that replaces yours.
- **If your PR is superseded**, the replacement links back to it and carries a `Co-authored-by:` trailer for you. Say so on the thread if you'd rather finish it yourself.

## Testing requirements

**This is not optional.** It's also the definition of done referred to at the top: a PR that meets all six, and says so honestly, is a finished change rather than a starting point.

1. **Unit tests for every change.** New features need tests. Bug fixes need a **regression test** that reproduces the original bug and fails without your fix. "I tested it manually" does not count.
2. **`npm run check` is clean.** Zero typecheck errors, zero new lint errors, formatted. The lint ratchet only moves one direction, and it gates per-rule as well as in total — you can't silence a rule in config to get under it.
3. **The full `npm test` passes.** Run the whole suite before pushing, not just the files you touched. Scoped runs have repeatedly missed failures. If a test breaks because of your change, update it deliberately and explain why in the PR. Don't delete tests to make them pass.
4. **Never widen a baseline to pass.** The ratchet baselines in `scripts/baselines/` are generated, not hand-edited. If your change legitimately moves one, regenerate it with the matching `*:update` script and say so in the PR.
5. **E2E tests when touching covered features.** CI doesn't run E2E on PRs, so if you modify a feature with an existing E2E test under `e2e/core/`, `e2e/full/`, or `e2e/online/`, run that spec locally before pushing:
   ```bash
   npm run build:e2e
   npx playwright test e2e/core/core-foo.spec.ts
   ```
   E2E runs against the built app, so a stale build silently tests the old bundle. New E2E tests go in `e2e/full/` unless they gate releases, in which case `e2e/core/`.
6. **No mocks at the seam you're fixing.** If the bug is in IPC, test against a real IPC round-trip. If it's in PTY spawn, test against a real spawn. Mocks are for dependencies of the code under test, not for the code under test itself.

Tests live in `__tests__/` folders next to the code they cover. Vitest for unit/integration, Playwright for E2E. Note there's no `@testing-library/jest-dom` in this repo — `toBeInTheDocument` throws. Use plain DOM reads.

## Code style

Daintree optimizes for **high signal-to-noise**. Code should be obvious enough that it doesn't need narration.

- **Minimal comments.** Comment _why_, not _what_. Don't write docstrings for self-evident functions. No decorative headers or banner comments.
- **No `any`.** Use `unknown` and narrow, or define the real type. If you genuinely need `any`, leave a comment explaining why.
- **Small, focused functions.** If a function needs a section header inside it, it probably wants to be two functions.
- **Don't add speculative abstractions.** Three similar lines is better than a premature helper. Build the abstraction when the third caller actually exists.
- **Don't expand scope.** A bug fix shouldn't clean up surrounding code. A feature PR shouldn't reformat adjacent files. Keep diffs reviewable.
- **Never hand-edit generated output.** Generated IPC types, keyboard-shortcut docs, drizzle migrations, and ratchet baselines are regenerated from source, never patched.
- **No emojis in code or commits** unless explicitly requested.

Formatting is handled by Prettier and ESLint — don't hand-format.

## Electron specifics

Daintree is a multi-process Electron app. A few things that will get a PR rejected on first pass if you miss them:

- **Renderer has no Node access.** All native/system calls go through the preload bridge (`electron/preload.cts`) using `contextBridge.exposeInMainWorld`. Don't enable `nodeIntegration`. Don't use the deprecated `remote` module.
- **Renderer state is per project view.** Each project gets its own `WebContentsView` and V8 context, with LRU eviction under memory pressure. Nothing in the renderer is a process-wide singleton unless it's explicitly a shared global.
- **IPC is typed end-to-end.** New channels go in `electron/ipc/channels.ts`, handlers in `electron/ipc/handlers/<domain>.ts`, preload exposure in `electron/preload.cts`. The renderer-facing types in `shared/types/ipc/generated*.ts` are generated — run `npm run codegen:ipc && npm run codegen:ipc-renderer`, don't edit them. Skipping any layer fails `npm run check`.
- **Main vs renderer boundary matters.** Services that touch `node-pty`, `simple-git`, or the filesystem belong in `electron/services/`. React, Zustand, and xterm belong in `src/`. Shared types go in `shared/`.
- **Version pinning is load-bearing.** Daintree is on **Electron 42**, **@xterm/xterm 6.1 (beta)**, **@xterm/addon-fit 0.12 (beta)**, **React 19**, and **Tailwind v4**. There are real breaking changes between these and older versions, and the beta xterm line in particular has removed APIs that most published advice still assumes. Research against the version in `package.json`, not against whatever the top search result covers.
- **Actions go through `ActionService`.** If you're adding a user-facing operation, add it to `shared/types/actions.ts` and create a definition in `src/services/actions/definitions/`. Don't wire menus or keybindings to raw handlers. The same manifest is the MCP tool surface, so an action's metadata is a public contract for external agents.

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
- **Security-sensitive changes** (IPC surface, preload bridge, MCP tool surface, `shell.openExternal`, file system writes, network fetches) warrant an extra pass. Flag them.

Reviewing a PR you didn't write is itself a contribution, and a good one.

## Releases

Releases are cut from `develop` into a release branch, tagged, and merged to `main` by maintainers. Contributors don't need to do anything here — see `docs/release.md` if you're curious about the process.

## Questions

- **Found a bug?** Open an issue with a reproduction.
- **Have a feature idea?** Open an issue describing the problem first, not the solution.
- **Not sure if something belongs in Daintree?** See `docs/feature-curation.md`, then ask on the issue.
- **Stuck on something in this guide?** Open an issue tagged `docs` and we'll fix the guide.

Thanks for contributing.
