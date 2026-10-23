# Choosing models

Read only when the user asks for the right model for each job, or for a lighter and a stronger model by difficulty (for instance Sonnet on one worker and Opus on another). Without that request, every pane keeps the user's default or the model they set, and none of this applies.

## Sizing

`/next-batch` sizes every issue in its report (`· small`, `· medium`, `· large`), and that size is its tier, close to the runbook `daintree.agents.choose-agent-model`'s light, standard and heavy:

- **Large is heavy** (needs judgment: an ambiguous cause, architecture, auth, data or schema changes, security, multi-subsystem work): the stronger model (Opus).
- **Small and medium** (mechanical, or settled design across several files): the lighter model (Sonnet). Sonnet is capable.

Never re-size an issue yourself; `/next-batch` already picks the larger size when torn.

## Caps and overflow

- Each model, or the worker running it, takes up to its cap.
- **Heavy overflow waits.** Large (heavy) issues beyond the strong side's cap are left out of the batch entirely and come back in a later pick. They never go to the lighter model. The strong side's slots go to the heavy issues that rank highest: priority first, then how much they unblock.
- **Small and medium overflow may go to the strong side** while it has room. When the user is saving the lighter worker's allowance, prefer that.

## The pick

`/next-batch` splits only into even counts and has no way to leave heavy overflow out, so it never places issues by model. Ask it for one unsplit ranked list with **no count** (SKILL.md's pick prompt with `Run /next-batch.` and no other arguments, plus any filters): it reads every candidate's thread whatever the count, so the whole ready frontier costs no more, and it gives the overflow rule something to choose from. The rule that a pick may not exceed `<size>` doesn't apply to this pick.

Then place the issues here against each side's refill count, in two passes over the `🟩 all ·` line, which is priority order:

1. **Large first.** Walk it for large issues only, giving each to the strong side while it has room. Past that, large issues are left out.
2. **Then small and medium.** Walk it again for those, giving each to the lighter side while it has room, then to whatever the strong side has left. When the user is saving the lighter side's allowance, use the strong side's leftover room first. Past that they are left out.

The first pass is what keeps the strong side for the highest-ranked heavy issues: a small issue ranked above them never takes their slot.

Left-out issues are never created, so they stay unassigned and come back in a later pick. Save every unit with its side, and with its worker when the sides are workers.

Expect batches to be heavy-weighted: on 2026-10-22, 36 of a ready frontier came out heavy, so the strong side filled first and most heavy issues waited.

## Launching

Pass the unit's model as `"model"` on every launch (`sonnet`, `opus`: the aliases `agent.listModels` lists), and keep it in the unit. On one machine the two sides are just two caps: the user's for each, else the batch size split evenly. Check the banner on the first launch of each model per batch (`workers.md`, Calling a worker).
