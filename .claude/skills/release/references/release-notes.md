# Release notes

How a release section in `CHANGELOG.md` and the GitHub Release body are shaped and written. This file is the source of truth; `docs/release.md` points here.

## The two surfaces

`CHANGELOG.md` is the chronological record. Each release prepends a section:

```markdown
## [X.Y.Z] - YYYY-MM-DD

[Intro paragraph.]

### Breaking Changes

- Entry (#NNN)

### Features

**Area**

- Entry (#NNN)

### Bug Fixes

**Area**

- Entry (#NNN)

### Performance

- Entry (#NNN)
```

- The `## [X.Y.Z] - YYYY-MM-DD` heading is required. Date it the day the release commit is made.
- Section order: Breaking Changes, Features, Bug Fixes, Performance, Other Changes. All `###`. Omit any that would be empty; omit Other Changes unless something user-relevant fits nowhere else (a platform support change, a security note).
- In any section with more than about six entries, group under `**Area**` bold paragraphs. Use the areas recent releases use so readers can scan across versions: Remote Hosts, Terminals and agents, Assistant, Canopy, Voice, Dev preview, Worktrees and files, Settings, MCP Server, Plugins, Memory and stability, Windows, Linux, macOS. Invent a new area only when a release has a real cluster that fits none.
- Issue and PR references as `(#NNN)` at the end of the line, several comma-separated when a line folds several PRs. They auto-link on GitHub.

The GitHub Release body is the same section with the `## [X.Y.Z] - YYYY-MM-DD` line removed. GitHub already shows the version and date. Everything else is verbatim, with no trailing `---` and no "Full Changelog" link, because GitHub shows the compare link in the header.

## The intro paragraph

Required on every release, including patches. It states the theme the way the last few releases do: lead with the headline story in one concrete clause (what changed for the user and the number that shows it), then a comma-run of the next four to six stories. Fragment-friendly, technical, no marketing words ("exciting", "powerful", "seamless", "we're thrilled"). For a patch release, say what was wrong with the previous version and that it's fixed.

Read the intros of the top three released sections before writing one. Match their register and length (two or three sentences, up to about 90 words).

## Writing an entry

One line per entry. An entry tells a user what they can now do or what no longer goes wrong, in the product's words, specific enough to recognise:

- Name the surface the way the UI names it, with the path when it's a setting: `Settings › Hosts › "Answer from another device"`.
- Give the concrete behaviour and the boundary: what triggers it, what it covers, what it deliberately doesn't. `only private addresses (loopback, RFC 1918, tailnet 100.64/10, IPv6 ULA) are dialled` is the level of detail recent entries carry.
- A fix says what the user saw before, not what the code did: "the kill took the pty-host and every running agent with it", not "fixed watchdog timeout".
- Keyboard shortcuts give both platforms: `Cmd+Click` (`Ctrl+Click` on Windows and Linux).
- Code identifiers in backticks only when the user types or reads them (MCP tool names, config keys, CLI flags, env vars).
- No implementation detail a user can't observe (store names, refactors, which process owns what), no PR-speak ("this PR", "now properly"), no hedging.
- Fold related PRs into one line: a feature and its three follow-up fixes inside the window are one Features entry citing all four numbers, not a feature plus three Bug Fixes.

## Breaking changes

Anything that makes a user, a plugin author or an MCP client change what they do: a removed or renamed setting, action, MCP tool or manifest key; a changed default that alters behaviour; dropped platform support; a config file format change. Each entry states what changed and what to do instead, in the same line: "Plugin manifests can no longer declare `contributes.previewTools`; … so remove them (#13891)". Pre-1.0, breaking changes ride a minor bump.

## What leaves the notes

- Churn inside the window: a feature added then reverted, an intermediate fix superseded by a later one, add-then-remove pairs. Net effect against the baseline only.
- Fixes for bugs that never shipped: a regression introduced and fixed inside the window is not a Bug Fix. It isn't anything.
- Work a normal user can't reach in this build: gated off by default with no setting, dev-only, behind an unpublished binary (the native bundled Assistant is the standing example; the Assistant backed by Claude Code or Codex is shipped and announceable), plugin-lab and test fixtures.
- Internal-only: tests, CI, build scripts, refactors, docs, skills, lint and budget baselines, unless a user can observe the result (a faster cold start from a refactor is Performance).

Control-plane plumbing that an external surface really exposes (MCP tools, plugin APIs) is listed even when Daintree's own consumer of it is unreleased, framed by what the external caller gets.

## Calibrating size

Scale the number of entries with what shipped, not their length. Recent sections run from about 15 bullets (a focused minor) to about 90 (0.44.0, 0.46.0). A release built from several hundred PRs lands near the top of that range: curate hard rather than exceed it, folding small fixes in one area into a single line that names the symptoms. Lead every section with its most consequential entries; within an area, features users will notice first.

## The Unreleased section

PRs that change something users must act on (breaking changes, migrations) sometimes write their entry under `## [Unreleased]` at the top of `CHANGELOG.md` as they merge. Those authors knew their change best: fold their entries into the new section verbatim, unless a later PR in the window changed what they describe, then remove the `## [Unreleased]` heading entirely. Don't leave an empty Unreleased section behind; the next PR that needs one adds it.
