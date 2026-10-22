# Choosing models

Read only when the user asks for the right model for each job, or for a lighter and a stronger model by difficulty (for instance Sonnet on one worker and Opus on another). Without that request, every pane keeps the user's default or the model they set, and none of this applies.

## Sizing

The pick sizes every issue with the tiers of the runbook `daintree.agents.choose-agent-model`:

- **Light:** mechanical and fully specified: a rename, a lint or typo fix, a version bump.
- **Standard:** a feature or bug fix in code the agent can read and test.
- **Heavy:** an unknown cause, a cross-cutting refactor or migration, concurrency, security, data or schema changes, architecture other work builds on, or a long unattended run.

Light and standard go to the lighter model (Sonnet); heavy goes to the stronger one (Opus). Sonnet is capable: borderline issues go wherever there is room.

## Caps and overflow

- Each model, or the worker running it, takes up to its cap.
- **Heavy overflow waits.** Heavy issues beyond the strong side's cap are left out of the batch entirely and come back in a later pick. They never go to the lighter model. The strong side's slots go to the heavy issues that rank highest: priority first, then how much they unblock.
- **Light and standard overflow may go to the strong side** while it has room. When the user is saving the lighter worker's allowance, prefer that.

## The pick prompt

Write the rules out for `/next-batch` in its filters, for example:

`… these filters: across 2 instances, split by difficulty rather than evenly. Size every issue as light (…), standard (…) or heavy (…). Instance 2 runs Opus and takes the heavy issues, at most 10: if more than 10 are heavy, keep the 10 that rank highest (priority first, then how much they unblock) and leave the rest out of this batch entirely; never put a heavy issue on instance 1. Instance 1 runs Sonnet and takes light and standard issues, at most 10. If more than 10 are light or standard, put the extras on instance 2 while it has room. Borderline issues go wherever there is room.`

Expect batches to be heavy-weighted: on 2026-10-22, 36 of a ready frontier came out heavy, so the strong side filled first and most heavy issues waited.

## Launching

Pass the unit's model as `"model"` on every launch (`sonnet`, `opus`: the aliases `agent.listModels` lists), and keep it in the unit. On one machine, the same split chooses each launch's model. Check the banner on the first launch of each model per batch (`workers.md`, Calling a worker).
