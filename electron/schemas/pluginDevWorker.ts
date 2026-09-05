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

import v8 from "node:v8";
import { z } from "zod";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  PluginWorkerToHostMessage,
} from "../../shared/types/pluginDevWorker.js";

/**
 * Admission ceiling on a single inbound worker message, measured as its
 * V8-serialized size. Generous enough to clear the largest legitimate payload
 * the protocol carries (a clipboard image plus envelope) while still bounding
 * what one message can cost main. This is an admission bound, not a transport
 * bound: Electron has already decoded the message by the time we see it.
 */
export const MAX_WORKER_MESSAGE_BYTES = 32 * 1024 * 1024;

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
      debounceMs: z.number().optional(),
      processId: z.string().optional(),
    }),
    z.object({ type: z.literal("unsubscribe"), subscriptionId: CorrelationId }),
  ]),
  InvokeResultSchema,
]);

/**
 * Compile-time proof the schema still accepts every shape the protocol defines.
 * Drop a field or tighten a type past what `PluginWorkerToHostMessage` allows
 * and this stops resolving to `true`, so assigning `true` to it fails the
 * build — the drift that would otherwise show up as a working plugin being
 * killed for a protocol violation it did not commit.
 */
type _SchemaAcceptsProtocol =
  PluginWorkerToHostMessage extends z.infer<typeof PluginWorkerToHostMessageSchema> ? true : never;
const _schemaAcceptsProtocol: _SchemaAcceptsProtocol = true;
void _schemaAcceptsProtocol;

/**
 * Field paths and Zod issue codes for a rejected message — never the offending
 * values. A `ZodError`'s own `message` inlines the input, and a caller's failure
 * reason ends up in the plugin's user-visible `loadError`, so the raw values
 * must not survive the parse boundary at all.
 */
function summarizeIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    seen.add(`${issue.path.join(".") || "(root)"}: ${issue.code}`);
  }
  return [...seen].slice(0, 8).join("; ");
}

export type WorkerMessageParseResult =
  { ok: true; message: PluginWorkerToHostMessage } | { ok: false; issues: string };

/** Validate one raw message off the worker's port. Never throws. */
export function parseWorkerToHostMessage(raw: unknown): WorkerMessageParseResult {
  const parsed = PluginWorkerToHostMessageSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: summarizeIssues(parsed.error) };
  // Safe by `_SchemaAcceptsProtocol` above: the schema is a strict subset of
  // the protocol union, modulo `z.unknown()` fields that Zod infers as optional
  // and the protocol declares required.
  return { ok: true, message: parsed.data as PluginWorkerToHostMessage };
}

/**
 * V8-serialized size of one inbound message, or `null` when it cannot be
 * measured (a symbol, or anything else outside the clone algorithm). Callers
 * treat `null` as a violation: a message main cannot size is not one it should
 * hand onward.
 */
export function measureWorkerMessageBytes(raw: unknown): number | null {
  try {
    return v8.serialize(raw as Parameters<typeof v8.serialize>[0]).byteLength;
  } catch {
    return null;
  }
}
