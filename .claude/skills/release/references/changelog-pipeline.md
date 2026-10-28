# Changelog pipeline

A release here spans hundreds of PRs (v0.46.0 → develop was 590 in a week), far more than one context can read properly. The changelog is built map, reduce, verify: analysts read the PRs in parallel chunks, an editor consolidates their findings into one draft, an adversarial checker tests the draft against the code, and you settle the result. Every stage writes to files in a work directory, so only summaries come back into your context.

Use the scratchpad: `W=<scratchpad>/release-vX.Y.Z`.

## 1. Collect

SKILL.md Phase 1 starts this in the background as soon as the release is pinned:

```bash
node .claude/skills/release/scripts/collect-changes.mjs --out "$W/changes" --head "$RELEASE_SHA"
```

It takes PR numbers from develop's first-parent merge commits in `<tag>..$RELEASE_SHA` (exact: no merged-date guessing), refuses a baseline it can't place or a shallow clone that cuts the range, fetches title, body, size, closing issues and file list for each in batched GraphQL calls, and writes:

- `summary.json`: counts by type, breaking candidates, the chunk index (each chunk's PR count and scopes).
- `chunk-NN.json`: about 40 PRs each, clustered by conventional-commit scope so a feature and its follow-ups or revert usually reach the same analyst.
- `internal.json`: test, CI, docs, chore and refactor PRs that touch no shipped path. These are dropped without analysis.
- `direct.json`: commits pushed straight to develop without a PR (stabilize fixes, small follow-ups), plus any first-parent merge that isn't a PR merge, flagged `nonPrMerge`, whose side history the editor reads by hand.

It takes about a minute for 600 PRs. Print one status line from `summary.json` ("590 PRs and 28 direct commits since v0.46.0: 291 feat, 188 fix, 16 perf; 15 chunks").

## 2. Map: one analyst per chunk

Launch every analyst in a single message so they run concurrently (`Agent`, `subagent_type: general-purpose`, background). One per chunk; if there are more than 16 chunks, rerun the collector with a larger `--chunk` instead of launching more agents. While they run, keep going: watching a dry run and reading the top of `CHANGELOG.md` don't depend on them.

The analyst brief, filled in per chunk:

```
You are one of several analysts drafting release notes for Daintree vX.Y.Z (repo: <abs path>, read-only:
do not edit, commit or push). Read <W>/changes/chunk-NN.json: about 40 PRs merged to develop since
<last tag>, each with title, body, files and closing issues. Also read
.claude/skills/release/references/release-notes.md: it defines what belongs in the notes and how
entries are written.

For every PR decide what a user of the released app gets from it, relative to <last tag>:
- Read the body. When the title and body don't settle what a user sees, read the diff
  (`gh pr diff <n>`) or the code at <RELEASE_SHA>. Don't guess from the title.
- Spot churn: a PR that reverts, replaces or fixes another PR merged in this same window (in your
  chunk or not; `gh pr list --state merged --search "<keywords>"` finds siblings). A fix for a bug
  introduced inside the window is not a Bug Fix. A feature later removed is nothing.
- Spot what a normal user can't reach: off by default with no setting, dev-only, unreleased surfaces.
- Spot breaking changes: removed or renamed settings, actions, MCP tools, manifest keys, changed
  defaults, dropped platforms.

Write <W>/analysis/chunk-NN.json: an array of
  { "prs": [numbers], "kind": "breaking|feature|fix|perf|other|drop",
    "area": "<area from release-notes.md>", "entry": "<one changelog line in house style, ending (#n, #m)>",
    "dropReason": "<churn|never-shipped-bug|not-user-visible|internal, when kind is drop>",
    "relatesTo": [PR numbers outside this chunk it reverts/extends/supersedes],
    "confidence": "high|medium|low", "note": "<anything the editor should check>" }
Several PRs that make one user-visible change are one object. Every PR in the chunk appears in exactly
one object. Then reply with five lines at most: counts by kind and the two most notable items.
```

## 3. Reduce: one editor

When every analysis file exists, launch one editor agent:

```
You are the editor for Daintree vX.Y.Z's release notes (repo: <abs path>, read-only except <W>).
Inputs: every <W>/analysis/chunk-*.json, <W>/changes/direct.json, <W>/changes/summary.json, the
`## [Unreleased]` section of CHANGELOG.md if present, the top three released sections of CHANGELOG.md
(calibration), and .claude/skills/release/references/release-notes.md (the rules).

1. Resolve cross-chunk churn: follow every relatesTo link. A feature in one chunk reverted or
   superseded in another nets out; a fix to a feature introduced in the window folds into that feature.
2. Merge entries that describe one change from different chunks.
3. Fold the Unreleased entries in verbatim unless a PR in the window changed what they describe.
4. Read direct.json for user-visible direct commits.
5. Write the section to <W>/draft.md exactly as it will appear in CHANGELOG.md, heading
   `## [X.Y.Z] - <today>` included, following release-notes.md: intro, sections, areas, size calibrated
   to recent releases. Curate: the analyses will over-supply.
6. Write <W>/draft-decisions.md: each dropped item with a medium/low confidence or a note, and why,
   plus anything you were unsure was user-visible.
Reply with the section's bullet counts per section and the intro paragraph.
```

## 4. Verify: one adversarial checker

Then one more agent, which sees the draft and not the analysts' reasoning:

```
Adversarially check the draft release notes in <W>/draft.md for Daintree vX.Y.Z against the code
(repo: <abs path>, read-only except <W>). The draft was written from PR descriptions; your job is to
find where it is wrong about the product as it exists at <RELEASE_SHA>.

For every Breaking Changes entry and every Features entry, and a sample of at least a third of the Bug
Fixes, find the code that implements it at <RELEASE_SHA> and check: it exists and isn't reverted
(`git log --oneline <last tag>..<RELEASE_SHA> --grep=Revert`), it's reachable by a user of the
release build (not behind a dev-only or default-off gate with no setting), the details are right
(setting names and paths, defaults, platforms, shortcuts, limits, numbers), and it wasn't already in
<last tag> (check CHANGELOG.md's earlier sections). Also look for omissions: a user-visible feat PR in
<W>/changes/chunk-*.json with no entry and no drop decision in <W>/draft-decisions.md.

Write <W>/verify.md: one item per problem, with the entry, what is wrong, the evidence (file:line or
commit), and the corrected line or "remove". Reply with the number of problems by kind.
```

## 5. Settle

Read `draft.md`, `draft-decisions.md` and `verify.md`. Check each verifier finding yourself before acting on it (it can be wrong too; a claim about the code is settled by reading the code). Apply what holds up, then write the final section to `$W/changelog-vX.Y.Z.md`.

The decisions that used to be questions for the user are yours now. When it's unclear whether something is user-visible, leave it out and list it under "Left out" in the status update, so the call is visible.

Print the status block from SKILL.md Phase 3, then the full section, and move on.

## Small releases

Under about 60 PRs, skip the editor and verifier agents: run the analysts (or read the PRs yourself if it's under 20), write the draft yourself, and verify the Breaking Changes and Features entries against the code yourself.
