// Runtime validation for the worker → main leg of the plugin dev-worker
// protocol (#12276).
//
// A plugin dev worker is a `utilityProcess.fork` child running third-party
// code, and that code can reach `process.parentPort` directly — the SDK proxy
// is not the only possible sender. So everything arriving on the child's
// `message` channel is untrusted input, not a `PluginWorkerToHostMessage`.
// Before this schema existed the main-side ingress read `msg.type` straight
// off the callback, so a `null` or primitive message threw a `TypeError` that
// escaped into `uncaughtException` and took the whole app into fatal recovery
// over one plugin's bug.
//
// Main-only on purpose: the worker and the SDK proxy import the protocol with
// `import type`, so keeping the schema out of `shared/` keeps Zod out of the
// worker bundle's dependency graph.
//
// Mirrors the `AssistantHostEventSchema` pattern in `./ipc.ts` — a
// `z.discriminatedUnion` on the envelope tag, which fails closed on `null`,
// primitives and a missing/unknown tag without ever throwing.

import { z } from "zod";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  PluginWorkerToHostMessage,
} from "../../shared/types/pluginDevWorker.js";

/**
 * Finite allowlists for the two method vocabularies. Written as records keyed
 * by the shared union so `satisfies` fails typecheck in BOTH directions — a
 * method added to `PluginHostCallMethod` with no entry here, and an entry here
 * that is not a real method. A `z.enum` over a hand-copied array would drift
 * silently in the first direction, which is the one that matters: a missing
 * entry would start rejecting a legitimate call and kill working plugins.
 */
const HOST_CALL_METHODS = {
  getActiveWorktree: true,
  getWorktrees: true,
  getWorktreesResult: true,
  getWorktreeStatus: true,
  getAgentState: true,
  sendToActiveAgent: true,
  showToast: true,
  dispatch: true,
  "actions.list": true,
  "actions.get": true,
  "settings.get": true,
  "settings.set": true,
  "storage.get": true,
  "storage.set": true,
  "storage.delete": true,
  "fs.readFile": true,
  "fs.readFileBytes": true,
  "fs.writeFile": true,
  "fs.readdir": true,
  "fs.stat": true,
  "fs.watch": true,
  "git.status": true,
  "git.diff": true,
  "git.add": true,
  "git.commit": true,
  "clipboard.writeText": true,
  "clipboard.writeImage": true,
  "clipboard.readText": true,
  "system.openPath": true,
  "system.showItemInFolder": true,
  showQuickPick: true,
  showInputBox: true,
  showConfirm: true,
  "process.spawn": true,
  "process.restart": true,
} as const satisfies Record<PluginHostCallMethod, true>;

const HOST_NOTIFY_METHODS = {
  registerAction: true,
  registerHandler: true,
  broadcastToRenderer: true,
  postToPanel: true,
  invalidateFileDecorations: true,
  setPanelBadge: true,
  registerFileDecorationProvider: true,
  unregisterFileDecorationProvider: true,
  "logger.info": true,
  "logger.warn": true,
  "logger.error": true,
  "process.kill": true,
  "process.write": true,
  "process.resize": true,
} as const satisfies Record<PluginHostNotifyMethod, true>;

const SUBSCRIPTION_KINDS = {
  "active-worktree": true,
  worktrees: true,
  settings: true,
  storage: true,
  "agent-state": true,
  "panel-lifecycle": true,
  "system-wake": true,
  "process-exit": true,
  "process-crash": true,
  "process-data": true,
} as const satisfies Record<PluginWorkerSubscriptionKind, true>;

function allowlist<T extends string>(methods: Record<T, true>): z.ZodEnum<Record<T, T>> {
  return z.enum(Object.keys(methods) as [T, ...T[]]);
}

const HostCallMethodSchema = allowlist<PluginHostCallMethod>(HOST_CALL_METHODS);
const HostNotifyMethodSchema = allowlist<PluginHostNotifyMethod>(HOST_NOTIFY_METHODS);
const SubscriptionKindSchema = allowlist<PluginWorkerSubscriptionKind>(SUBSCRIPTION_KINDS);

/**
 * Correlation ids must be non-empty strings: they key the bridge's
 * `hostCallAborts` / `pendingInvokes` / `subscriptionDisposers` maps, so an
 * empty id would collide every request onto one entry.
 */
const CorrelationId = z.string().min(1);

/**
 * Union of the settings and storage scope vocabularies — one `subscribe`
 * envelope carries both, and which one applies is decided by `kind` on the
 * bridge side.
 */
const SubscriptionScopeSchema = z.enum(["user", "project", "local", "worktree"]);

/**
 * Any number, `NaN` and infinities included. Zod v4's `z.number()` rejects
 * those, but the host already normalizes a nonsense `debounceMs` to zero — so
 * treating one as a terminal violation would kill a plugin whose call the
 * pre-schema path served without complaint.
 */
const AnyNumber = z.custom<number>((value) => typeof value === "number");

/**
 * Opaque method payloads and invoke results. Explicitly `.optional()`: Zod v4
 * (unlike v3) treats a bare `z.unknown()` as a REQUIRED key, and a worker that
 * omits `params` for a no-argument call is not committing a protocol violation
 * worth killing it over.
 */
const OpaquePayload = z.unknown().optional();

/**
 * `invoke-result` is the one tag with two shapes, so it discriminates a second
 * time on `ok`. It cannot be two entries of the outer union: a discriminated
 * union maps each tag to exactly one option.
 */
const InvokeResultSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("invoke-result"),
    requestId: CorrelationId,
    ok: z.literal(true),
    result: OpaquePayload,
  }),
  z.object({
    type: z.literal("invoke-result"),
    requestId: CorrelationId,
    ok: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Every message the worker is allowed to send main. Objects strip unknown keys
 * (Zod's default), so the value handed downstream carries only declared fields.
 */
export const PluginWorkerToHostMessageSchema = z.union([
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ready"),
      permission: z.object({ present: z.boolean() }).optional(),
    }),
    z.object({ type: z.literal("activated"), hasCleanup: z.boolean() }),
    z.object({
      type: z.literal("activate-error"),
      error: z.string(),
      stack: z.string().optional(),
    }),
    z.object({ type: z.literal("error"), error: z.string() }),
    z.object({
      type: z.literal("host-call"),
      requestId: CorrelationId,
      method: HostCallMethodSchema,
      params: OpaquePayload,
    }),
    z.object({ type: z.literal("host-cancel"), requestId: CorrelationId }),
    z.object({
      type: z.literal("host-notify"),
      method: HostNotifyMethodSchema,
      params: OpaquePayload,
      registrationKey: z.string().optional(),
    }),
    z.object({
      type: z.literal("subscribe"),
      subscriptionId: CorrelationId,
      kind: SubscriptionKindSchema,
      key: z.string().optional(),
      scope: SubscriptionScopeSchema.optional(),
      debounceMs: AnyNumber.optional(),
      processId: z.string().optional(),
    }),
    z.object({ type: z.literal("unsubscribe"), subscriptionId: CorrelationId }),
  ]),
  InvokeResultSchema,
]);

/**
 * The protocol with its two opaque payload fields relaxed to optional — the one
 * intentional gap between what the schema infers and what the shared types
 * declare, since Zod v4 has no "required unknown".
 */
type WireMessage<T = PluginWorkerToHostMessage> = T extends { params: unknown }
  ? Omit<T, "params"> & { params?: unknown }
  : T extends { result: unknown }
    ? Omit<T, "result"> & { result?: unknown }
    : T;

/**
 * Compile-time proof the schema and the protocol describe the same messages,
 * checked in BOTH directions because each catches a different drift.
 *
 * Protocol → schema catches a field the schema tightened past what a real
 * worker sends, which would kill a working plugin for a violation it did not
 * commit. Schema → protocol catches a field the schema DROPPED: structurally an
 * object with an extra property still extends one without it, so the first
 * direction alone would let the schema silently strip (say) `requestId` while
 * {@link parseWorkerToHostMessage} keeps advertising it.
 *
 * Two things stay out of reach here and are pinned by the schema's test
 * fixtures instead: runtime refinements (`.min(1)`, the method enums), and a
 * dropped OPTIONAL field — an object without an optional property is assignable
 * in both directions, so only the round-trip fixture notices if `debounceMs`
 * goes missing.
 */
type _SchemaMatchesProtocol = (WireMessage extends z.infer<typeof PluginWorkerToHostMessageSchema>
  ? true
  : never) &
  (z.infer<typeof PluginWorkerToHostMessageSchema> extends WireMessage ? true : never);
const _schemaMatchesProtocol: _SchemaMatchesProtocol = true;
void _schemaMatchesProtocol;

/**
 * Field paths and Zod issue codes for a rejected message — never the offending
 * values. A `ZodError`'s own `message` inlines the input, and a caller's failure
 * reason ends up in the plugin's user-visible `loadError`, so the raw values
 * must not survive the parse boundary at all.
 */
function summarizeIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  const walk = (issues: readonly z.core.$ZodIssue[]): void => {
    for (const issue of issues) {
      // A union issue's own path is the root, so descend — otherwise every
      // rejection reads "(root): invalid_union" and says nothing.
      const nested = (issue as { errors?: (readonly z.core.$ZodIssue[])[] }).errors;
      // A union issue's own path is the root, so descend into its branches. An
      // EMPTY `errors` array is what Zod reports for a bad discriminator, and
      // that leaf's own path is the useful part — descending would lose it.
      if (nested?.length) {
        for (const group of nested) walk(group);
        continue;
      }
      seen.add(`${issue.path.join(".") || "(root)"}: ${issue.code}`);
    }
  };
  walk(error.issues);
  return [...seen].slice(0, 8).join("; ") || "(root): invalid_union";
}

export type WorkerMessageParseResult =
  { ok: true; message: PluginWorkerToHostMessage } | { ok: false; issues: string };

/** Validate one raw message off the worker's port. Never throws. */
export function parseWorkerToHostMessage(raw: unknown): WorkerMessageParseResult {
  const parsed = PluginWorkerToHostMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: summarizeIssues(parsed.error) };
  // Safe by `_SchemaMatchesProtocol` above: the schema is a strict subset of
  // the protocol union, modulo `z.unknown()` fields that Zod infers as optional
  // and the protocol declares required.
  return { ok: true, message: parsed.data as PluginWorkerToHostMessage };
}
