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

Some green the app inherited rather than invented, and repainting it would make the app wrong rather than restrained. Git status letters (`A`, `?`), diff insertion counts, ahead arrows, added lines in a patch. Alongside these sit the affirmative halves of paired controls — the `Plus` against the `Minus` on a stage row, the run and apply affordances — where green means "go", not "good". None of them is claiming anything is healthy.

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

`severity="success"` requires `autoDismissAfter` and `onClose` at the type level. A success banner that stands is not expressible: the compiler, not review, is what stops one being written. Persistent completion is `severity="neutral"` — which is what `AgentCompletionBanner` already uses to say "N files changed, review when ready".

## The guard

Enforcement is a contract test, at occurrence level: `src/config/__tests__/statusSuccessGuard.contract.test.ts`, with its data in `statusSuccessInventory.ts`.

It parses every production `.ts`/`.tsx` under `src/` and collects **paint sites** — string literals and template quasis containing a `status-success` Tailwind utility or a `var(--color-status-success)` read. Every site must appear in the inventory with a category and a rationale. Sites are keyed by a **signature** (the success-bearing lexemes of the literal, whitespace collapsed) plus an optional **anchor** (any substring of an enclosing node) when a signature repeats inside one file. Reformatting a component does not churn the inventory; changing which success utility it paints does.

Deliberate boundaries:

- **No file allowlist.** `FileStageRow` holds both git notation that stays and a row wash that had to go. Allowing the file would leave the door open forever — which is exactly how the accent guard's file-level buckets miss a second bad occurrence in a file already on the list.
- **No pre-existing bucket, permanent or temporary.** Every entry states why its green is allowed today.
- **Painting, not defining.** `applyAppTheme` and `ColorVisionPicker` name the token to build and preview the palette. The policy protects `--color-status-success` itself, so the layer defining it is out of scope by construction.
- **Not ESLint.** A lint rule cannot infer a timer, a modal's lifetime, or checklist structure out of a `cn()` call. The rationale field is where that judgement lives, and it is reviewed by people.
- **TS/TSX only.** CSS files are outside the scan: `src/index.css` defines the token and `DiffViewer.css` is diff notation.

What it catches: a new green anywhere in `src/`, a second green in a file that already has approved ones, a removed green whose entry lingers, and a wholesale move that keeps every per-site check passing. What it cannot catch: a rationale that is not true. The count ratchets exist so that even an equal-count swap has to be explained.

## Review checklist

1. Can you name the specific result, required item, or live operation? If you are reaching, it is ambient health — demote it.
2. Does it clear on its own, or does the user have to leave the screen? Only the first is transient.
3. If it stays, what is the non-colour channel — text, glyph, geometry, or a real border?
4. If it is a running process, is it on `activity-working` rather than `status-success`?
5. If you demoted it, did you avoid replacing it with a toast, an inbox entry, or a banner?
