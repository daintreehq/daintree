---
name: monitoring-sweep
description: "Sweep every open GitHub issue labelled `monitoring` and decide whether the external event each one is waiting on has actually happened. Monitoring issues are blocked on something outside the repo's control (an upstream stable release, a third-party repo going public, a dependency shipping a fix, a spec landing), so they are not workable, only checkable. This skill reads each issue, works out the precise trigger condition, researches the real current state of that external thing, and reports which issues are now READY to work, which are still WAITING, and which are STALE or obsolete. Run it roughly monthly, or whenever the user asks to check the monitoring issues, sweep monitoring, or see if anything we were waiting on has landed. Reports by default and only comments on issues or changes labels when the user asks for it."
---

# Monitoring sweep

Daintree's `monitoring` label marks issues that are blocked on an external event nobody here controls: an upstream package shipping a stable release, a third-party repository going public, a bug being fixed in a dependency, a standard being finalised. They cannot be worked, only checked. `next-batch` skips them and so does normal issue work.

The cost of that is drift. An issue can sit for months after its trigger has already fired, because nobody went and looked. This skill is the periodic look.

The job: for every open `monitoring` issue, determine the exact condition it is waiting on, go and find out the real current state of that condition, and classify the issue. Report. Do not start implementing anything.

## Ground rules

- **Read-only by default.** Report findings in the terminal. Do not post comments, change labels, close issues, or start work unless the user explicitly asks. Several of these issues are old and a wrong "this is ready!" comment is noise on a public repo.
- **Verify, never assume.** "The version number in the issue body looks old" is not evidence the trigger fired. Go check the registry, the repo, the release page. A monitoring issue exists precisely because the answer lives outside this repository.
- **The issue body can be stale.** Versions get bumped, scope changes, related work lands. Compare the trigger against the repo's *current* state, not against what the issue said when it was written.
- **Be honest about uncertainty.** If a trigger is vague ("when the ecosystem settles"), say so and flag it as needing a human decision rather than inventing a verdict.

## Procedure

### 1. Collect

```bash
gh issue list --label monitoring --state open --limit 100 --json number,title,body,createdAt,updatedAt,labels,comments
```

If the list is empty, say so and stop. That is a valid, good outcome.

Also skim closed monitoring issues once in a while to catch a trigger that fired and was handled without the label being cleaned up:

```bash
gh issue list --label monitoring --state closed --limit 20 --json number,title,closedAt
```

### 2. Extract the trigger

For each issue, read the full body and every comment, then write down the trigger as a single testable condition. The issue often states it outright. Look for:

- "once X ships / is released / lands / goes stable / goes public"
- "when `latest` reaches N"
- "blocked on upstream <repo>#<number>"
- "revisit when …"
- an explicit check command, e.g. `npm view <pkg> dist-tags`

If a body gives no testable condition, do not guess one. Record it as **UNCLEAR** and move on. That is a finding in itself: the issue needs a human to define what it is actually waiting for.

### 3. Check the real world

Pick the check that matches the trigger. Prefer the cheapest authoritative source.

**npm package version or dist-tag**

```bash
npm view <package> dist-tags
npm view <package> versions --json | tail -20
```

Compare against what the repo actually pins today (`package.json`), not the version quoted in the issue body.

**GitHub repo going public, a release, or an upstream fix**

```bash
gh repo view <owner>/<repo> --json name,isPrivate,pushedAt 2>&1
gh release list --repo <owner>/<repo> --limit 5
gh issue view <number> --repo <owner>/<repo> --json state,stateReason,closedAt,title
gh pr view <number> --repo <owner>/<repo> --json state,mergedAt,title
```

A `Could not resolve to a Repository` error means it is still private or does not exist. Check whether the *org* exists and when it was last active. That distinguishes "abandoned" from "coming soon".

**Anything else (a spec, a vendor blog post, a product launch, a browser or runtime shipping a feature)**

Ask Google (`mcp__ask-google__ask_google`) for the current state, then confirm the answer against a primary source with WebFetch: the vendor's changelog, the release page, the spec repo. Google is good at telling you *whether* something shipped and roughly when; it is not the citation. A forum post or a model summary claiming something shipped is not confirmation.

**Electron, Chromium, Node, or V8 versions**

Check against the versions this repo actually targets. `CLAUDE.md` documents the current Electron and Chromium line and the `build.target` in `vite.config.ts`. An upstream fix landing in a Chromium newer than ours has not reached us yet.

Run independent checks in parallel. Each issue's check is unrelated to the others.

### 4. Classify

Give every issue exactly one verdict:

| Verdict | Meaning |
|---|---|
| **READY** | The trigger has verifiably fired. The issue is now workable. |
| **WAITING** | Confirmed still blocked. Include the current state so the next sweep starts from real numbers. |
| **PARTIAL** | Something moved but the trigger has not fully fired (a beta advanced, a fix merged but is unreleased, a repo appeared but is empty). |
| **STALE** | The issue has been overtaken. The work landed another way, the dependency was dropped, or the premise no longer holds. Recommend closing. |
| **UNCLEAR** | No testable trigger. Needs a human to define one. |

### 5. Report

One table, then a short paragraph per non-WAITING issue explaining what was checked and what was found. Keep WAITING rows to a single line each; the whole point is that nothing happened.

```
| # | Title | Verdict | Current state |
|---|-------|---------|---------------|
```

For each READY issue, state plainly what changed and what the next action is. Do not start that action.

End with a one-line recommendation: which issues (if any) want the label removed, which want closing, and whether anything needs Greg's decision.

### 6. Act only if asked

If the user asks to follow through, then and only then:

- **READY** → remove the `monitoring` label so `next-batch` can pick it up. Add a brief comment stating the trigger fired and the evidence.
- **STALE** → propose closing with a reason. Confirm with the user before closing anything.
- **UNCLEAR** → ask the user what the trigger should be, then edit the issue body to record it so the next sweep is cheap.

Never bundle these into the report run. Reporting and mutating are separate steps, and the user decides when to cross that line.

## Worked example

Issue #9547, "Upgrade `@xterm/*` from 6.1.0-beta to 6.1.0 stable once released", states its own check: `npm view @xterm/xterm dist-tags`, flip when `latest` reaches `6.1.0`.

```bash
npm view @xterm/xterm dist-tags
# { latest: '6.0.0', beta: '6.1.0-beta.302' }
```

`latest` is still on the 6.0 line, so the verdict is **WAITING**. Worth recording in the report that the repo's own pins have moved on since the issue was written (`package.json` now pins `6.1.0-beta.300`, while the body still lists `6.1.0-beta.221`), because that drift is exactly what makes a stale body misleading on the next sweep.

## Done means

- Every open `monitoring` issue has a verdict backed by a check that was actually run.
- No issue was classified from the body alone.
- Nothing was commented, relabelled, or closed unless the user asked for it.
