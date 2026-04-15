# GitHub Issue Guidelines

When helping a user submit a feature request or bug report to the Daintree repository (`canopyide/canopy`), use these guidelines to ensure the issue is well-scoped and likely to be accepted.

## What Daintree Is

Daintree is a **desktop orchestration layer for AI coding agents**. It manages panels, terminals, worktrees, context injection, and automation workflows around CLI agents (Claude, Gemini, Codex, OpenCode, Cursor). It is NOT a code editor, Git GUI, or chat interface.

Issues must relate to orchestration concerns — how users launch, monitor, coordinate, and intervene with agents and their surrounding workflows.

## Feature Requests

A good feature request must pass Daintree's **Green Light test** — it should satisfy at least two of these criteria:

1. **Accelerates context injection** — Makes it faster to feed the right files, errors, diffs, or screenshots to an agent
2. **Unblocks the agent** — Detects when an agent is stuck, waiting, or failed and helps the user intervene
3. **Manages multiplicity** — Helps manage multiple concurrent agents or worktrees that a human can't track alone
4. **Bridges the gap** — Fixes friction between CLI agents and the GUI orchestration layer
5. **Provides omniscience** — Aggregates data from multiple isolated contexts into one view
6. **Enables automation** — Allows reactive workflows that reduce manual monitoring
7. **Reinforces identity** — Strengthens visual distinctiveness, accessibility, or personalization

**Reject features that:**

- Reinvent the code editor (use VS Code for editing)
- Reinvent a Git GUI (Daintree does lightweight commit/push only)
- Reinvent a chat UI (agents run in terminals, not chat bubbles)
- Require excessive configuration (Daintree should work with zero config)
- Add decoration without conveying state or aiding workflows
- Duplicate what the CLI agent already does well without adding orchestration value
- Are one-off utilities better solved with a shell alias or external tool

**Format:**

```
## Summary
[1-2 sentences: what and why]

## Current Behavior
[What happens now]

## Proposed Behavior
[What should happen instead]
```

Keep it concise. Don't over-specify implementation details — the maintainers know the codebase.

## Bug Reports

Bug reports are accepted when they describe a clear, reproducible problem with an existing Daintree feature.

**Good bug reports include:**

- What the user was doing when the problem occurred
- What they expected to happen
- What actually happened
- Their operating system (macOS, Windows, or Linux)

**Format:**

```
## Summary
[What's broken, in one sentence]

## Steps to Reproduce
[Numbered steps]

## Expected Behavior
[What should happen]

## Actual Behavior
[What happens instead]

## Environment
[OS, Daintree version if known]
```

**Don't submit bug reports for:**

- Issues with the AI agents themselves (Claude, Gemini, Codex) — those belong in their own repos
- Problems with the user's terminal, shell, or git installation
- Feature gaps (use a feature request instead)

## Before Submitting

1. **Search existing issues first** — Check if the problem or request is already tracked. If it is, tell the user about the existing issue instead of creating a duplicate.
2. **Confirm with the user** — Show them the draft title and body. Get explicit approval before creating the issue.
3. **Use clear titles** — Start with a verb: "Add...", "Fix...", "Improve...". Be specific, not vague.
4. **One issue per concern** — Don't bundle multiple unrelated requests into a single issue.
5. **Label appropriately** — Use `bug` for bugs and `enhancement` for feature requests.
