---
name: release-packages
disable-model-invocation: true
argument-hint: "[package or 'all'] [patch|minor] — e.g. `sdk minor`, `all patch`, or nothing to be asked"
description: "Release the plugin author npm packages (@daintreehq/plugin-sdk, @daintreehq/plugin-vite, daintree-plugin, create-daintree-plugin): work out which ones changed since they were last published, bump their versions with the correct cascade through dependents and the scaffold's version ranges, open the bump PR to develop, and, once main carries the bump, cut the per-package tags that make release-packages.yml publish through npm Trusted Publishing. Use this whenever the user wants to publish, release, bump, version, or ship any of the plugin packages or the plugin SDK, CLI or Vite preset, even if they only say 'push a new SDK' or 'get the CLI fix out'. Do not use it for the Electron app release; that is the `release` command."
---

# Release Packages

Release the four plugin author packages that live in `packages/` and publish through `.github/workflows/release-packages.yml`. This is a human-driven workflow with checkpoints: use `AskUserQuestion` at each one and never move past it without an answer. The user decides versions and timing, you do the bookkeeping and keep the invariants honest.

**Argument (may be empty):** `$ARGUMENTS`. A package name (`sdk`, `vite`, `cli`, `create`, or `all`) and an optional bump size pre-answer the questions in Phase 0. Confirm them anyway.

## What gets released

| Package | Directory | Tag prefix | Depends on |
| --- | --- | --- | --- |
| `@daintreehq/plugin-sdk` | `packages/plugin-sdk` | `sdk-v` | nothing (peers: react, zod) |
| `@daintreehq/plugin-vite` | `packages/plugin-vite` | `plugin-vite-v` | nothing (peers: vite, react) |
| `daintree-plugin` | `packages/daintree-plugin` | `daintree-plugin-v` | scaffolds pin sdk, vite and itself |
| `create-daintree-plugin` | `packages/create-daintree-plugin` | `create-daintree-plugin-v` | `daintree-plugin` |

`@daintreehq/svelte-source-model` is private and never published. `@daintreehq/plugin-testing` no longer exists; its mock host ships as `@daintreehq/plugin-sdk/testing`.

## The invariants the workflow enforces

Read `.github/workflows/release-packages.yml` once before starting; it is the source of truth. The rules that shape this skill:

- **Versions are independent.** Bump only what changed. One tag push publishes every package whose `package.json` version is not yet on the registry and skips the rest, so several bumps can ride one tag.
- **A tag must match its package's version exactly** or the run fails on purpose.
- **Anything that publishes must be a commit on `main`.** The workflow checks ancestry. Package tags are therefore cut from `main`, after the bump has ridden a normal app release there. Never tag `develop` or a feature branch.
- **Publishing needs no token.** Each package has this repo and this workflow registered as its npm trusted publisher, so the workflow publishes with an OIDC token and provenance. The skill never runs `npm publish` itself. The one exception is a package that has never been published: npm cannot register a trusted publisher for a package that does not exist, so its first version is published by hand from a logged-in laptop, after which the trusted publisher is added on npmjs.com. If `npm view <name> version` returns E404, tell the user that is where they are and point them at the maintainer note in `docs/plugins/dev-loop.md`.

## The version cascade

This is the part that goes wrong when done by hand. Several places pin these packages with caret ranges on 0.x versions, and on 0.x a caret only spans patch releases: `^0.1.0` means `>=0.1.0 <0.2.0`. A **minor** bump of one package therefore invalidates every range that points at it, and each file that changes lives in another package that then needs its own bump.

| When this gets a minor bump | These ranges must move with it | Which means this package bumps too |
| --- | --- | --- |
| `@daintreehq/plugin-sdk` | `packages/daintree-plugin/src/scaffold/templates.ts` devDependency `@daintreehq/plugin-sdk` | `daintree-plugin` (patch at least) |
| `@daintreehq/plugin-vite` | `packages/daintree-plugin/src/scaffold/templates.ts` devDependency `@daintreehq/plugin-vite` | `daintree-plugin` (patch at least) |
| `daintree-plugin` | `packages/daintree-plugin/src/scaffold/templates.ts` devDependency `daintree-plugin`, its assertion in `packages/daintree-plugin/src/__tests__/new.test.ts`, and `packages/create-daintree-plugin/package.json` dependency `daintree-plugin` | `create-daintree-plugin` (patch at least) |

A **patch** bump changes no ranges and cascades nowhere. Find every pinned range with `git grep -n -E '"(@daintreehq/plugin-(sdk|vite)|daintree-plugin)": "\^' -- packages` rather than trusting this table; a new pin added since this was written is exactly the kind of thing that slips.

Pre-1.0 sizing, unless the user says otherwise: a change an author can see (new export, new CLI flag, new scaffold output, changed behaviour) is **minor**; a fix, a docs-only or test-only change, or a rebuild with no visible difference is **patch**. Breaking changes are also minor on 0.x, and the changelog line must say so. There is no separate changelog file for the packages; the PR body and the GitHub release notes carry it.

## Phase 0: What changed, and which packages need a release

1. Read every published version and the version in the tree, and list the changes since each package's last tag:

```bash
for p in plugin-sdk plugin-vite daintree-plugin create-daintree-plugin; do
  name=$(node -p "require('./packages/$p/package.json').name")
  echo "$name tree=$(node -p "require('./packages/$p/package.json').version") npm=$(npm view "$name" version 2>/dev/null || echo unpublished)"
done
git tag -l 'sdk-v*' 'plugin-vite-v*' 'daintree-plugin-v*' 'create-daintree-plugin-v*' | sort -V
git log --oneline <last-tag-for-that-package>..HEAD -- packages/<dir>
```

2. The SDK re-exports `shared/`, so its changes are not confined to its directory. Also inspect `git log <sdk-tag>..HEAD -- shared/types/plugin.ts shared/types/plugin-sdk.ts shared/types/plugin-sdk-react.ts shared/testing/createMockHost.ts shared/config/panelKindRegistry.ts`, and run `npm run check:api-surface`: a snapshot diff is by definition a public SDK change and rules out a patch.

3. Classify each package as unchanged, patch, or minor, apply the cascade table, and present the proposal:

> ### Release proposal
>
> | Package | Published | Proposed | Why |
> | --- | --- | --- | --- |
> | @daintreehq/plugin-sdk | 0.1.0 | 0.2.0 | new `./testing` entry, `PanelViewProps.worktreeId` |
> | daintree-plugin | 0.1.0 | 0.1.1 | cascade: scaffold range for plugin-sdk moves to ^0.2.0 |
> | create-daintree-plugin | 0.1.0 | unchanged | |
>
> **Go with these versions?**

Offer the alternatives explicitly (bump everything, only the package the user named, different sizes). If a tree version is already ahead of npm, say so: that means a bump PR has landed and Phase 3 is what remains.

## Phase 1: Preflight

Run all of these before touching a version. Stop and report if any fails.

- Working tree clean and on `develop`, up to date with `origin/develop` (`git fetch origin` first). Bumps ride a PR into `develop` like everything else; never commit a bump straight to `main`.
- `npm run packages:build` succeeds.
- `npx vitest run packages shared/testing plugins/sample plugins/sample-project` passes.
- `npm run check:api-surface` passes, or the diff is understood and will be committed with the bump via `npm run api-surface:update`.
- No open PR already bumping these packages (`gh pr list --search "packages release" --state open`).

Checkpoint: show the results and ask to proceed.

## Phase 2: Apply the bump

1. Create the branch: `git checkout -b release/packages-<YYYY-MM-DD> develop`.
2. For each package being bumped, from the repo root, then sync the lockfile's workspace entry, which `npm version` leaves behind:

```bash
npm version <new> --workspace=packages/<dir> --no-git-tag-version
npm install --package-lock-only --ignore-scripts
```

`--package-lock-only` rewrites `package-lock.json` without touching `node_modules`, which is what makes it safe in a worktree whose install is shared with the main checkout. Confirm with `git diff package-lock.json` that the workspace entry now carries the new version and nothing else moved.

3. Apply the cascade edits from the table with `Edit`, one range at a time, and grep again for the old range afterwards so none survives.
4. Rebuild and prove it: `npm run packages:build`, then `npx vitest run packages shared/testing plugins/sample plugins/sample-project`, then `npm run check`. A range the tests still assert at the old value is the common failure here.
5. Show the user the full diff (`git diff`) and the file list, then commit:

```
chore(packages): release plugin-sdk 0.2.0, daintree-plugin 0.1.1

- bump @daintreehq/plugin-sdk to 0.2.0 for the ./testing entry and worktreeId on view props
- bump daintree-plugin to 0.1.1 so scaffolds pin plugin-sdk ^0.2.0
```

No attribution trailers. Checkpoint before pushing: confirm the branch, the commit and that a PR into `develop` is about to open.

6. Push and open the PR with `gh pr create --base develop`. The body is the release notes: one line per package with the version and what an author gets. The PR merges through the usual review; this skill does not merge it.

Then stop. Say plainly that the tags come later, once the bump has reached `main` through an app release, and that running this skill again at that point picks up at Phase 3.

## Phase 3: Tag from main

Enter here when `main` already carries versions that npm does not have. Verify that first:

```bash
git checkout main && git pull origin main
for p in plugin-sdk plugin-vite daintree-plugin create-daintree-plugin; do
  name=$(node -p "require('./packages/$p/package.json').name")
  echo "$name main=$(node -p "require('./packages/$p/package.json').version") npm=$(npm view "$name" version 2>/dev/null || echo unpublished)"
done
```

If `main` and npm agree for every package, there is nothing to tag; say so. If a package on `main` is behind `develop`, the bump has not been released to `main` yet and tagging now would publish the wrong thing; say that and stop.

Checkpoint: list the tags about to be created, one per package whose `main` version is ahead of npm, with the exact name (`sdk-v0.2.0`), and ask.

```bash
git tag -a sdk-v0.2.0 -m "@daintreehq/plugin-sdk 0.2.0"
git push origin sdk-v0.2.0
```

Push each tag by name. Never `git push --tags`; that pushes every local tag, including app release tags. One tag is enough to publish every unpublished package, but creating a tag per bumped package keeps the history readable, and the extra runs are no-ops.

Then watch the run to the end: `gh run list --workflow=release-packages.yml --limit 1` and `gh run watch <id> --exit-status`. The workflow builds, tests, smoke-installs the tarballs, publishes, and polls the registry. Confirm afterwards with `npm view <name> version` for each package. If the run fails before publish, nothing was published; fix on `develop`, and expect to delete and recreate the tag once `main` has the fix, with the user's confirmation for the force push of that one named tag. If it fails after a package published, that version is permanent; the next attempt needs a new version.

## Phase 4: After the first ever publish

Only when a package went from unpublished to published (done by hand, see the invariants): remind the user to register the trusted publisher and the "require 2FA and disallow tokens" setting on each package page on npmjs.com, then remove the "not yet published" wording from the plugin docs. The maintainer note at the top of `docs/plugins/dev-loop.md` lists every file that carries it; open a small docs PR into `develop`.

## Safety rules

- Never force-push a branch. A tag may be force-pushed only by name, during a re-tag, with confirmation.
- Never tag anything other than a commit on `main`, and never a version that differs from the package's `package.json` on that commit.
- Never run `npm publish` from this skill; the workflow publishes. The manual first publish is the user's action, at their terminal, because it needs their 2FA.
- Never run `npm ci` in a worktree, and never a plain `npm install` to update versions; `npm version --workspace --no-git-tag-version` plus `npm install --package-lock-only --ignore-scripts` is what keeps `package-lock.json` consistent without touching the shared install.
- If any step fails, stop and report what happened and what the user can do. Do not improvise a recovery.
