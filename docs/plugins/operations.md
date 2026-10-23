# Durable operations

`@daintreehq/plugin-sdk/operations` runs remote jobs that must outlive a single call: an export a provider builds over minutes, a deployment, a long agent run behind an API. An MCP tool call or an action has a bounded lifetime, and a [task](./host-api.md#tasks--long-running-work) is held only in memory, so a worker reload, a project close or an app restart loses track of work the provider is still doing. The operation manager journals each job in a plugin database before anything is acknowledged or sent, and picks it up again on the next start.

It is deliberately small: one operation is one remote job, submitted once and polled to an end. There are no steps, graphs or signals, and nothing runs while the plugin isn't running; work only resumes when the plugin activates again.

## Setup

Declare a local database the manager owns, and register the action a task's Retry runs. It applies its own migrations, so the file holds nothing else, and `local` keeps the journal out of the repository.

```json
"contributes": {
  "databases": [{ "id": "operations", "location": "local" }]
}
```

```ts
import {
  createOperationManager,
  OperationError,
  type OperationKind,
} from "@daintreehq/plugin-sdk/operations";

const exportKind: OperationKind<{ reportId: string }, { url: string }> = {
  title: (input) => `Exporting report ${input.reportId}`,
  pollIntervalMs: 5_000,
  provider: {
    async submit(input, { idempotencyKey, signal }) {
      const job = await api.createExport(input.reportId, { idempotencyKey, signal });
      return { providerId: job.id };
    },
    async poll({ providerId }, { signal }) {
      const job = await api.getExport(providerId, { signal });
      if (job.state === "done") return { status: "succeeded", result: { url: job.url } };
      if (job.state === "error") return { status: "failed", message: "The export failed" };
      return { status: "running", progress: { fraction: job.progress } };
    },
    async reconcile(_input, { idempotencyKey, signal }) {
      const job = await api.findExportByKey(idempotencyKey, { signal });
      return job ? { status: "found", providerId: job.id } : { status: "not-found" };
    },
    async cancel({ providerId }, { signal }) {
      await api.cancelExport(providerId, { signal });
      return "requested";
    },
  },
};

export async function activate(host) {
  const operations = createOperationManager(host, {
    database: "operations",
    retryActionId: "acme.reports.resumeOperation",
    kinds: { export: exportKind },
  });
  await host.registerAction(
    { id: "resumeOperation", title: "Resume Operation", kind: "command" },
    async (args) => {
      await operations.retry(String(args?.operationId));
    }
  );
  await operations.start();
  return { deactivate: () => operations.dispose() };
}
```

An MCP tool then submits and answers with the id at once, and a second tool reads the status, instead of holding the call open for the whole job:

```ts
const op = await operations.submit(
  "export",
  { reportId },
  {
    idempotencyKey: `export:${reportId}:${requestId}`,
    projectId: caller.projectId,
  }
);
return { operationId: op.id, state: op.state };
```

## Lifecycle

| State | Meaning |
| --- | --- |
| `pending` | Journaled, not yet sent (or proven never received). |
| `submitting` | The submit call is in flight. Found at start-up, the plugin stopped mid-call, and it becomes `uncertain`. |
| `uncertain` | The submit may have reached the provider. It is reconciled before anything is sent again. |
| `running` | The provider has it under `providerId`; it is polled. |
| `succeeded`, `failed`, `cancelled` | What the provider reported. A `cancelled` is the provider's, or one that was never sent. |
| `abandoned` | The manager stopped tracking it (deadline, retries spent, or `abandon`); the provider's outcome is unknown. |

**Submission.** `submit` commits the row and returns before the provider hears of it. The same `idempotencyKey` with the same request returns the existing operation, however it ended, until retention prunes it; the same key with a different request throws `OperationConflictError`. Without a key every submit is a new operation. The manager admits at most `maxUnfinished` (200) unfinished operations and throws `OperationCapacityError` past that.

**Uncertain side effects.** The row is committed `submitting` before the provider is called. A submit that throws, times out or is cut off by a restart is `uncertain`: the manager calls `reconcile` with the same idempotency key. Found continues polling, `not-found` sends it again under the same key, and `unknown` backs off and asks again. A provider without `reconcile` must deduplicate on the key, because an uncertain submit is simply sent again.

**Retry and backoff.** A failed provider call waits a random time up to `min(maximumIntervalMs, initialIntervalMs × backoffCoefficient^(n−1))` (defaults 1 s, ×2, 60 s) and, after `maximumAttempts` (10) consecutive failures, the operation is abandoned. A poll that says "still running" is not a failure. An `OperationError` with `retryable: false` is final: from `submit` it means the provider refused and nothing happened (`failed`), from `poll` that the job failed.

**Timeouts.** Each provider call gets `callTimeoutMs` (30 s) and a `signal` that aborts at the limit. A timed-out call is a failure to retry, never evidence the provider cancelled or failed. Each operation has a `deadlineMs` (24 h) after submission: one never sent fails, one already sent is abandoned.

**Cancel.** `cancel(id)` — or the user pressing Cancel on its task — records the request. An operation never sent is `cancelled` at once. Otherwise the provider's `cancel` is asked: `"cancelled"` ends it, `"requested"` keeps polling until the provider reports how it ended, and `"unsupported"` (or no `cancel` at all) keeps tracking it to its real end. A success can win the race. `cancelRequested` on the snapshot says a cancel was asked; only `state` says what happened.

**Resume.** `retry(id)` drives an unfinished operation again, and gives an abandoned one a fresh deadline and retry budget, polling it if the provider id is known or reconciling it if not. It never starts a second provider job. A failed operation stays failed; submit a new one.

## Tasks and sleep

Every operation being driven holds one [task](./host-api.md#tasks--long-running-work), at most `concurrency` (4, at most 16) at once, including while it waits out a poll interval or backoff. That task is what the user sees, and for a project-scoped plugin it is what keeps the project awake. Operations beyond `concurrency` wait in the journal without a task, so they don't hold the project; a sleeping project resumes them when it wakes.

The task's Cancel records a cancel request. An interruption (the plugin unloading, restarting or crashing) records nothing: the signal's `reason.cause` is `"interrupted"`, so the operation stays as it was and resumes with a new task on the next `start`. `dispose` stops driving, finishes the tasks it held, and closes the journal.

Recovery runs in the plugin's worker, not in a view: `start` from `activate` resumes work whether or not any panel is open. A project plugin's journal is its own, and resumes when that project opens again. An app-wide plugin's journal serves every project, so pass `projectId` to `submit` and filter `list({ projectId })` to show a project its own operations.

## Status and retention

`get(id)` and `list({ projectId, states, limit })` return snapshots: state, provider id, the last progress, the result once succeeded, a bounded error, and timestamps. `list` returns at most 100, newest first. Finished operations are pruned on `start` and by `prune()`: older than `retention.maxAgeMs` (7 days) or beyond the newest `retention.maxCount` (500). An idempotency key stops deduplicating once its operation is pruned, so keep retention at least as long as the provider honours its keys. Unfinished operations are never pruned.

## Secrets

The journal holds the input, the provider id, checkpoints, progress, results and errors, all as plain JSON in a file under the plugin's data directory. Keep credentials out of all of them: the adapter fetches its token at call time. Only an `OperationError`'s `code` and `message` are stored; any other error is stored as a generic `PROVIDER_ERROR` or `TIMEOUT`, never by its message, so a provider error that echoes a token never reaches the journal or a notification. A `failed` poll's `message` is stored as written, so write it for the user.

Sizes are capped: input 32 KB of JSON, a checkpoint 16 KB, a result 64 KB. An oversized result is dropped with `RESULT_NOT_STORED` on an otherwise succeeded operation; an oversized checkpoint abandons the operation, since resuming without it would lose its place.

## Testing

`createMockHost({ databases: { directory } })` gives the manager real SQLite. Dispose the manager and create another over the same directory to test a restart, `simulateTaskCancel` to press Cancel, and `simulateTaskInterrupt` to interrupt as an unload would.
