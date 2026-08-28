# Success Colour Policy

Green is the app's scarcest status colour, and it was spending itself on nothing. We were rendering a success signal as ongoing status in 55 places — not a confirmation of something the user just did, but standing chrome saying the thing is healthy, on surfaces people open repeatedly. Chrome that is always green trains people to stop reading it, and then the one time it is not green, they do not notice either.

This page is the rule, the categories, and the guard that holds them. It came out of #12002.

## The decision rule

**Green is allowed only for a confirmation that clears on its own, the recorded result of a named operation or check, an item in a finite checklist the user is currently working through, or a process that is running right now. Everything else goes neutral when the state still needs naming, and disappears when the good case is already implied.**

The review question, for anyone touching a `status-success` token:

> Can this green be named as a specific result, a required checked item, or a live operation? If not, it does not get to persist.

This falls out of the runtime-signal tiering in [notification-system.md](../architecture/notification-system.md). Active work earns one T1 marker. "Nothing needs attention" changes no user action, so it earns nothing.

Two corollaries that are easy to get wrong:

- **Removing green is not compensated.** No toast, no inbox entry, no banner in its place. The signal was not worth a colour; it is not worth an interruption either.
- **`--color-status-success` is never neutralised globally.** CI results, audit outcomes and diff semantics all read from it. The work is per-surface, always.

## The categories

| Category | Admits when | Verdict |
| --- | --- | --- |
| Transient confirmation | Clears on a timer, leaves with the operation or dialog, resets on input change | Keep |
| Finite gate or checklist | The current task requires each displayed item to become true | Keep one mark per item, neutral row surface |
| Enumerated outcome | Green is the recorded result of a named execution, not inferred health | Keep |
| Live operation | The running/stopped distinction is the primary datum | Keep the green, but retoken to `state-working` / `activity-working` |
| Threshold baseline | Green only because a number sits below a warning threshold | Demote |
| Ambient health | The good branch means "no exception currently detected" | Demote or remove |
| Membership, category, decoration | Green means staged, attached, selected, or section identity | Demote |
| Settled completion | Work has finished and is no longer asking for anything | Demote |

Git additions, insertion counts, ahead arrows and patch lines are domain notation, not success chrome. They stay, and they are not part of the count.

### Transient confirmations

The clipboard flash is the archetype: `copied` flips true, the glyph swaps to a `Check`, the label says "Copied", and a timer puts it back. Green is doing real work there — it marks the moment, and the moment ends.

A confirmation qualifies when something other than the user's attention takes it away: a timer, the dialog closing, the next keystroke. "The user will navigate away eventually" is not that.

### Finite gates and checklists

The setup wizard is the clean case. Every prerequisite has to become true before the user moves on, so each satisfied row keeps one green `CircleCheck`, plus the single completion summary. The review hub's per-file viewed marks are the same shape: the task is to get through every file.

The exception is about **task structure**, not about rows that happen to hold a boolean. The Settings agent list is not a checklist — it lists only installed agents, agents are optional alternatives, nothing requires every row to reach Ready, and the rows exist to navigate. So Ready went away there entirely and only the exception states render.

Where a gate does qualify: keep one mark per item, and keep the row surface neutral. A green mark plus a green row wash is the same fact twice. That is why `AgentCliStep` kept its inline "Installed" mark and lost its full-row wash, and why `FileStageRow` kept its viewed checkbox and lost its staged-row band.

A fully satisfied checklist may collapse to one summary line — but on a surface people open repeatedly that line is neutral, not green.

### Enumerated outcomes

Green here reports what happened when something ran: CI passed, the clone finished, the key validated, N runs succeeded. The distinguishing test is that a specific execution produced it. "No errors are currently detected" is not an outcome; it is ambient health wearing an outcome's clothes.

### Domain notation

Some green the app inherited rather than invented, and repainting it would make the app wrong rather than restrained. Git status letters (`A`, `?`), diff insertion counts, ahead arrows, added lines in a patch. This is the ruling's exemption and it is narrow: it covers notation, not anything that merely feels conventional.

### Affordances — an open question, not a ruled category

`affordance` is a fifth category, and the ruling did not name it. It covers the affirmative half of a control pair — run, apply, stage, resume, save, retry — where green means "go" rather than "good". These controls are not reporting state at all, so the review question ("can this green be named as a result, a checked item, or a live operation?") has no honest answer for them: they are not any of the three, and they are not health either.

They are also not in the #12002 ruling's demote list, so this series left them alone rather than widening its scope. Naming them separately is the point: folding them into `domain` would have quietly restated what the ruling meant by that word, and the sites would have stopped being visible as a decision anyone made.

If they should go neutral, delete the category — the guard will then list every site that needs fixing. If they should stay, this section is where the reasoning lives.

### Live operations

A process that is running right now keeps its green, but it belongs on `activity-working` (or its alias `state-working`), not `status-success`. The two resolve to adjacent hues in every built-in theme, so this is a semantic move rather than a visible one: "in flight" stops being spelled the same way as "succeeded". It also takes those sites out of the guard entirely, which is the point — a running server is not a success, and the inventory should not have to pretend otherwise.

`projectRowStatus`'s `running` tone, the MCP server's running dot, the dev-server indicator and the assistant's live-session mark all moved this way.

## The non-colour channel

Anything that keeps its green still needs a second channel, per #12000: visible text, a Lucide glyph, distinct geometry, or a real border. An `aria-label` alone is not a visible channel.

Use a real `border`, never a `ring-*` substitute. `box-shadow` — which is what `ring-*` compiles to — is stripped outright under `forced-colors: active`, while borders and outlines survive and map to system colours. Marks that are a bare background disc carry the `.status-mark` hook so `forced-colors` can repaint them.

## Vocabulary when you demote

| Was | Becomes |
| --- | --- |
| `bg-status-success/5` … `/15` (row wash, badge fill) | `bg-overlay-subtle`, hover `bg-overlay-medium` |
| `border-status-success/20` … `/40` | `border-border-default` |
| `text-status-success` on a label | `text-text-secondary`, then `text-text-muted` |
| `ring-1 ring-status-success/30` | a real `border`, not another ring |

Use the semantic spelling, not the legacy `daintree-*` aliases — `border-border-default`, not `border-daintree-border` — and never fade a text colour with slash-alpha. Both are ratcheted by `component-contract/*` rules that fail the build on any per-rule increase; see [component-contract.md](./component-contract.md).

## InlineStatusBanner

`severity="success"` requires `autoDismissAfter` and `onClose` at the type level, so a success banner that never says how it leaves does not compile. The type can require a number but not a positive one — `autoDismissAfter={0}` still type-checks and would stand forever — so the component warns about that in dev builds rather than pretending the type closed it. Persistent completion is `severity="neutral"`, which is what `AgentCompletionBanner` already uses to say "N files changed, review when ready".

## The guard

Enforcement is a contract test, at occurrence level: `src/config/__tests__/statusSuccessGuard.contract.test.ts`, with its data in `statusSuccessInventory.ts`.

It parses every production `.ts`/`.tsx` under `src/` and under the builtin plugin renderers (which ship in the app and paint the same tokens) and collects **paint sites** — string literals and template quasis containing a `status-success` Tailwind utility or a `var(--color-status-success)` read. Every site must appear in the inventory with a category and a rationale. Sites are keyed by a **signature** (the success-bearing lexemes of the literal, whitespace collapsed) plus an optional **anchor** (any substring of an enclosing node) when a signature repeats inside one file. Reformatting a component does not churn the inventory; changing which success utility it paints does.

Deliberate boundaries:

- **No file allowlist.** `FileStageRow` holds both git notation that stays and a row wash that had to go. Allowing the file would leave the door open forever — which is exactly how the accent guard's file-level buckets miss a second bad occurrence in a file already on the list.
- **No pre-existing bucket, permanent or temporary.** Every entry states why its green is allowed today.
- **Painting, not defining.** `applyAppTheme` and `ColorVisionPicker` name the token to build and preview the palette. The policy protects `--color-status-success` itself, so the layer defining it is out of scope by construction.
- **Not ESLint.** A lint rule cannot infer a timer, a modal's lifetime, or checklist structure out of a `cn()` call. The rationale field is where that judgement lives, and it is reviewed by people.
- **TS/TSX only.** CSS files are outside the scan: `src/index.css` defines the token and `DiffViewer.css` is diff notation.

What it catches: a new green in any scanned root, a second green in a file that already has approved ones, a removed green whose entry lingers, a site claimed by two entries at once, and a move between files, which shows up as a stale entry on one side and an unclassified site on the other.

What it does not catch, stated plainly because a guard trusted past its reach is worse than no guard:

- **A rationale that is not true.** Nothing mechanical can check whether the timer a `transient` entry claims actually exists. That is what review is for.
- **Activations of an approved definition.** `badge.tsx`'s `tone="success"` and `button.tsx`'s `ghost-success` are each one inventoried site; every `<Badge tone="success">` that follows is invisible to the scanner. `InlineStatusBanner`'s `severity="success"` is the exception, and only because the type now forces it to dismiss itself.
- **The token reached indirectly.** A class name assembled from a variable, an interpolated `var(${token})`, a theme object read like `t["status-success"]`, or a value pulled through CSSOM all paint the colour without ever writing a utility a parser can see.
- **A one-for-one swap inside one file.** Deleting an approved site and adding the same signature back under the same anchor — or anywhere in that file, if the entry needed no anchor — holds every count and every per-site check. The anchors make this narrow, not impossible.
- **The Tailwind grammar drifting.** The utility roots are enumerated against the pinned Tailwind version, so a colour utility added upstream is unguarded until the list catches up.
- **The non-colour channel.** That every surviving green also speaks through text, a glyph, geometry or a border is a review obligation, not something the guard checks.

## Review checklist

1. Can you name the specific result, required item, or live operation? If you are reaching, it is ambient health — demote it.
2. Does it clear on its own, or does the user have to leave the screen? Only the first is transient.
3. If it stays, what is the non-colour channel — text, glyph, geometry, or a real border?
4. If it is a running process, is it on `activity-working` rather than `status-success`?
5. If you demoted it, did you avoid replacing it with a toast, an inbox entry, or a banner?
