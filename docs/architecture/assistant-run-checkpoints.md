# Assistant run checkpoints

Long-running Assistant procedures need a record that survives a conversation or app restart. `AssistantScratchService` can't hold it: scratch is per-instance and deleted on the next launch. Checkpoints live in a sibling root, `<userData>/assistant-run-checkpoints/`, that scratch cleanup never touches. The implementation is `electron/services/AssistantRunCheckpointService.ts`.

The Assistant writes every file. The app provisions the bucket, publishes its location, and runs a conservative sweep. It never parses a plan, schedules work, or replays anything, and there is no checkpoint IPC, database or document store.

## Layout

```
<userData>/assistant-run-checkpoints/<projectKey>/<runId>/
  cancelled                          tombstone; presence means stop
  writers/<writerId>/checkpoint.json
  writers/<writerId>/done.json       {"schemaVersion":1,"status":"completed"}
```

- `projectKey` is the immutable registered project id (it survives a folder move and is the same for Claude and Codex), or `global` for the future project-less Assistant. Registered ids are 64-char hex, so `global` can't collide.
- `runId` is chosen by the Assistant and claimed with a non-recursive `mkdir`.
- `writerId` is the session id, fresh per provision. Each writer only touches its own folder, so concurrent lanes and app instances can't overwrite each other. Competing branches of one run are kept, never merged.

## Launch context

A project Assistant's PTY gets `DAINTREE_ASSISTANT_RUN_CHECKPOINT_DIR` (the project's bucket) and `DAINTREE_ASSISTANT_RUN_CHECKPOINT_WRITER_ID`, beside `DAINTREE_ASSISTANT_SCRATCH_DIR`. A managed block in the session `CLAUDE.md` / `AGENTS.md` documents the convention below. Nothing is written to user agent config or project files. Provisioning the bucket must succeed for the Assistant to launch.

## Convention

- Write atomically: temp file in the same folder, flush, rename over the target.
- Store intent and resource references only, never credentials.
- Discovery is a directory listing. A run is unfinished unless it has `cancelled` or every writer folder has a valid `done.json`. A listing error is reported, never treated as an empty store.
- Cancel or discard: create `cancelled` first, then remove `writers/`. `cancelled` is never deleted, so a late notice can't restart the run.
- A checkpoint is memory, not authority: it grants no ownership, standing, consent or permission to repeat a write.

## Retention

The sweep runs at boot (deferred task `assistant-run-checkpoint-retention`) and from `PeriodicCleanupService`. Overlapping requests coalesce.

| Run state | Removed when |
| --- | --- |
| Finished (every writer has a valid `done.json`) | older than 30 days, or beyond the newest 100 in its bucket |
| Cancelled | payloads (`writers/`) after 7 days; the tombstone never |
| Unfinished, unreadable, malformed, unknown version | never; only explicit discard |

Removal never recurses over a run directory: a finished run's `writers/` is removed after a fresh re-check and the run directory is then removed with a plain `rmdir`, so a tombstone written meanwhile keeps it. Checkpoint bodies are opaque to the app; only terminal markers decide whether a run is finished. Symlinks and oddly named entries are skipped, never followed, and a symlinked bucket, run directory or `writers/` is refused or protected. Logs carry counts and error codes only, never run names or contents, and checkpoints are not part of diagnostic exports.
