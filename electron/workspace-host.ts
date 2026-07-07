// Dead-fd errnos that must not propagate on GUI launch (AppImage/Wayland, no
// terminal). EPIPE is a closed pipe; EIO is a disconnected pty (the primary
// errno for AppImage desktop launches where fd 2 points to an orphaned pty
// slave); EBADF is a closed fd; ECONNRESET is a socket-backed stdio reset.
// ENOSPC is intentionally NOT swallowed — it's a real error condition.
const STDIO_DEAD_CODES = new Set(["EPIPE", "EIO", "EBADF", "ECONNRESET"]);
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === "function") {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code && STDIO_DEAD_CODES.has(err.code)) return;
      throw err;
    });
  }
}

import nodeV8 from "node:v8";
// Cap at 2 total heap snapshots (anti-thrash). Snapshots block the event loop
// and each needs ~2x heap at creation time; after 2, V8 stops generating more
// to prevent the process burning remaining CPU on dumps instead of finalizing.
// The snapshot directory is controlled by `--diagnostic-dir` (a V8 execArgv
// flag set in WorkspaceHostProcess.ts) and is independent of `initializeLogger()` below.
nodeV8.setHeapSnapshotNearHeapLimit(2);

import { MessagePort } from "node:worker_threads";
import { initializeLogger, setLogLevelOverrides } from "./utils/logger.js";
import { copytreeWorkerClient } from "./workspace-host/CopytreeWorkerClient.js";
import { fileTreeService } from "./services/FileTreeService.js";
import { projectPulseService } from "./services/ProjectPulseService.js";
import type { CopyTreeProgress } from "../shared/types/ipc.js";
import type { WorkspaceHostRequest, WorkspaceHostEvent } from "../shared/types/workspace-host.js";
import type { WorktreePortRequest } from "../shared/types/worktree-port.js";
import { WorkspaceService } from "./workspace-host/WorkspaceService.js";
import { ensureSerializable } from "../shared/utils/serialization.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";
import { initForgeBridge } from "./workspace-host/forgeBridge.js";
import { fanoutEventToWorktreePorts } from "./workspace-host/worktreePortFanout.js";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { markHostPerformance } from "./utils/hostPerformance.js";
import {
  IdleHeapCompactor,
  resolveExposedGc,
  IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS,
} from "./services/pty/analysis/idleHeapCompactor.js";

// First user-code statement after all imports settle. ESM hoists native
// module dlopen (better-sqlite3 via WorkspaceService, @parcel/watcher) ahead
// of any statement here, so this is the earliest feasible proxy for "native
// modules loaded". The exact dlopen instant is not reachable from ESM.
markHostPerformance(PERF_MARKS.WORKSPACE_HOST_NATIVE_MODULE_READY);

// Validate we're running in UtilityProcess context
if (!process.parentPort) {
  throw new Error("[WorkspaceHost] Must run in UtilityProcess context");
}

if (process.env.DAINTREE_USER_DATA) {
  initializeLogger(process.env.DAINTREE_USER_DATA);
}

const port = process.parentPort as unknown as MessagePort;

// Worktree-specific ports with request/response correlation (Phase 1)
const worktreePorts: MessagePort[] = [];

// Event types delivered directly to renderers via MessagePort
const DIRECT_RENDERER_EVENTS = new Set([
  "worktree-update",
  "worktree-removed",
  // Host-originated active-worktree changes — fan out direct so the
  // per-view `WorktreeStoreContext` listener (`worktree-activated`) fires in
  // the same tick as any accompanying `worktree-removed` (the host-originated
  // auto-switch in `runTopologyReconcile` and `deleteWorktree`). The legacy
  // `CHANNELS.WORKTREE_ACTIVATED` echo path is still gated by PR #3603's
  // `silent` flag and is unaffected by this allowlist.
  "worktree-activated",
  "pr-detected",
  "pr-cleared",
  "pr-detection-state",
  "issue-detected",
  "issue-not-found",
  // Watcher degradation/recovery — delivered direct so each per-view store
  // can drive the persistent degraded indicator. The one-shot toast still
  // routes through the main-process relay (WorkspaceHostEventRouter); the two
  // paths are independent and both fire (dual delivery, existing pattern).
  "inotify-limit-reached",
  "emfile-limit-reached",
  "watcher-recovered",
  // Topology-watcher dark/recovery (#9908) — same direct-delivery rationale as
  // the watcher degradation events above: each per-view store drives the
  // shared Tier-1 indicator and arms the 30s escalation timer from the live
  // event. Without this a dark event fired after a view mounts never reaches
  // the renderer (the get-all-states handshake only covers mount-time state).
  "topology-watcher-dark",
  "topology-watcher-recovered",
  // Confirmed fetch-auth failure — delivered direct so the per-view
  // `WorktreeStoreContext` listener (`fetch-auth-failure-confirmed`) fires.
  // Renderer-only: there is no WorkspaceHostEventRouter case for this event,
  // so the main-process relay never carries it (#10778).
  "fetch-auth-failure-confirmed",
]);

function sendToWorktreePorts(event: WorkspaceHostEvent): void {
  fanoutEventToWorktreePorts(worktreePorts, event);
}

async function handleWorktreePortRequest(
  rPort: MessagePort,
  msg: WorktreePortRequest
): Promise<void> {
  const { id } = msg;
  try {
    let result: unknown;

    switch (msg.action) {
      case "get-all-states": {
        const states = workspaceService.getSnapshotsSync();
        const { epoch, seq } = workspaceService.getVersion();
        result = {
          states,
          epoch,
          seq,
          watcherDegraded: workspaceService.isWatcherDegraded(),
          topologyWatcherDark: workspaceService.isTopologyWatcherDark(),
          lastAcknowledgedMutationIds: workspaceService.getAcknowledgedMutationIds(),
        };
        break;
      }

      case "set-active": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        workspaceService.setActiveWorktree(requestId, msg.payload.worktreeId);
        result = { ok: true };
        break;
      }

      case "set-agent-activity": {
        workspaceService.setAgentActivity(msg.payload.worktreeIds);
        result = { ok: true };
        break;
      }

      case "refresh": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Forward the host's bounded outcome so a watchdog-tripped refresh
        // reaches the renderer as ok:false instead of a silent success.
        result = await workspaceService.refresh(requestId, msg.payload.worktreeId);
        break;
      }

      case "create-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.createWorktree(requestId, msg.payload.rootPath, msg.payload.options);
        result = { ok: true };
        break;
      }

      case "delete-worktree": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // `throwOnError: true` — port-backed callers (renderer outbox) need a
        // semantic failure to reject the port request so the outbox can
        // classify the error. The legacy IPC path keeps the old behavior
        // (resolve, emit `delete-worktree-result` event).
        await workspaceService.deleteWorktree(
          requestId,
          msg.payload.worktreeId,
          msg.payload.force,
          msg.payload.deleteBranch,
          msg.payload.mutationId,
          true
        );
        result = { ok: true };
        break;
      }

      case "list-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.listBranches(requestId, msg.payload.rootPath);
        result = { ok: true };
        break;
      }

      case "get-recent-branches": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.getRecentBranches(requestId, msg.payload.rootPath);
        result = { ok: true };
        break;
      }

      case "refresh-prs": {
        const { pullRequestService } = await import("./services/PullRequestService.js");
        await pullRequestService.refresh();
        result = { ok: true };
        break;
      }

      case "reconcile-topology": {
        workspaceService.scheduleTopologyReconcile(msg.payload.force ?? false);
        result = { ok: true };
        break;
      }

      case "resource-action": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const actionResult = await workspaceService.runResourceAction(
          requestId,
          msg.payload.worktreeId,
          msg.payload.action
        );
        if (!actionResult.success) {
          rPort.postMessage({ id, error: actionResult.error ?? "Resource action failed" });
          return;
        }
        result = { ok: true };
        break;
      }

      case "run-lifecycle-setup": {
        await workspaceService.retryLifecycleSetup(msg.payload.worktreeId);
        result = { ok: true };
        break;
      }

      case "switch-worktree-environment": {
        const requestId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await workspaceService.switchWorktreeEnvironment(
          requestId,
          msg.payload.worktreeId,
          msg.payload.envKey
        );
        result = { ok: true };
        break;
      }

      case "has-resource-config": {
        const hasConfig = await workspaceService.hasResourceConfig(msg.payload.rootPath);
        result = { hasConfig };
        break;
      }

      default: {
        const _exhaustive: never = msg;
        throw new Error(
          `Unknown worktree port action: ${(_exhaustive as { action: string }).action}`
        );
      }
    }

    rPort.postMessage({ id, result });
  } catch (error) {
    rPort.postMessage({ id, error: (error as Error).message });
  }
}

function attachWorktreePort(newPort: MessagePort): void {
  newPort.start();
  worktreePorts.push(newPort);

  newPort.on("message", (rawMsg: any) => {
    const raw =
      rawMsg && typeof rawMsg === "object" && "data" in rawMsg
        ? (rawMsg as { data: unknown }).data
        : rawMsg;
    if (!raw?.id || !raw?.action) return;

    // Renderer is trusted; runtime validation happens at the input boundary in
    // `WorktreePortClient.request<K>` via the typed protocol map. Cast here so
    // the dispatcher body can stay free of per-field `as` casts.
    const msg = {
      id: raw.id,
      action: raw.action,
      payload: raw.payload ?? {},
    } as WorktreePortRequest;

    handleWorktreePortRequest(newPort, msg).catch((err) => {
      try {
        newPort.postMessage({ id: msg.id, error: (err as Error).message });
      } catch {
        // Port closed
      }
    });
  });

  newPort.on("close", () => {
    const idx = worktreePorts.indexOf(newPort);
    if (idx >= 0) worktreePorts.splice(idx, 1);
  });

  console.log(`[WorkspaceHost] Worktree port attached (${worktreePorts.length} active)`);
}

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("[WorkspaceHost] Uncaught Exception:", err);
  try {
    sendEvent({ type: "error", error: err.message });
  } catch {
    // ignore
  }
  // Electron 37+ no longer crashes on unhandled rejection by default — exit explicitly
  // so the parent's child-process-gone supervision path triggers.
  setImmediate(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  console.error("[WorkspaceHost] Unhandled Rejection:", reason);
  try {
    sendEvent({
      type: "error",
      error: formatErrorMessage(reason, "Unhandled rejection in workspace host"),
    });
  } catch {
    // ignore
  }
  // Electron 37+ no longer crashes on unhandled rejection by default — exit explicitly
  // so the parent's child-process-gone supervision path triggers.
  setImmediate(() => process.exit(1));
});

// Idle heap compaction for this isolate: git polling churns transient strings
// and diff/status structures every cycle, and a utility process has nothing
// driving V8's idle memory reducer, so committed-but-free heap pages linger
// for minutes after a burst (same problem the pty-host compactor fixes).
// Activity = any inbound request or outbound event; the latch inside the
// compactor means at most one compacting GC per quiet period.
const idleHeapCompactor = new IdleHeapCompactor(resolveExposedGc());
const idleHeapCompactTimer = setInterval(() => {
  idleHeapCompactor.maybeCompact();
}, IDLE_HEAP_COMPACT_CHECK_INTERVAL_MS);
idleHeapCompactTimer.unref?.();

// Helper to send events to Main process (and directly to renderers for spontaneous events)
function sendEvent(event: WorkspaceHostEvent): void {
  idleHeapCompactor.noteActivity();
  try {
    port.postMessage(event);
  } catch (error) {
    console.error(
      `[WorkspaceHost] Failed to send event type "${(event as any).type}":`,
      formatErrorMessage(error, "Failed to send workspace event")
    );

    try {
      const sanitized = ensureSerializable(event);
      console.warn(`[WorkspaceHost] Sending sanitized event (non-serializable fields removed)`);
      port.postMessage(sanitized);
    } catch (sanitizeError) {
      console.error(
        `[WorkspaceHost] Failed to sanitize event, sending error event instead:`,
        formatErrorMessage(sanitizeError, "Failed to sanitize workspace event")
      );
      port.postMessage({
        type: "error",
        error: `Serialization failed for event type "${(event as any).type}"`,
      });
    }
  }

  // Direct delivery to renderer(s) via MessagePort (bypasses main-process relay)
  if (DIRECT_RENDERER_EVENTS.has((event as { type: string }).type)) {
    if (worktreePorts.length > 0) {
      sendToWorktreePorts(event);
    }
  }
}

// Process-level shutdown controller — aborted on dispose/SIGTERM to kill in-flight git operations
const shutdownController = new AbortController();

// Create singleton instance
const workspaceService = new WorkspaceService(sendEvent);

// Forge provider impls live in main (registered by `PluginService` when a
// plugin activates). This bridge is the workspace-host's only access path —
// every PR/CI/rate-limit call from `PullRequestService` round-trips here as a
// `forge:rpc` event and resolves when main answers with `forge:rpc-result`.
// Initialised before `port.on("message")` is attached so the very first
// inbound result has a bridge to route to. See
// `docs/architecture/forge-provider-abstraction.md` for the rationale.
const forgeBridge = initForgeBridge(sendEvent);

// Handle requests from Main
port.on("message", async (rawMsg: any) => {
  idleHeapCompactor.noteActivity();
  const msg =
    rawMsg && typeof rawMsg === "object" && "data" in rawMsg
      ? (rawMsg as { data: unknown }).data
      : rawMsg;

  // Handle MessagePort transfers (worktree-specific port with request/response correlation)
  const transferredPorts = rawMsg?.ports || [];
  if (msg?.type === "attach-worktree-port" && transferredPorts.length > 0) {
    attachWorktreePort(transferredPorts[0] as MessagePort);
    return;
  }

  try {
    const request = msg as WorkspaceHostRequest;

    switch (request.type) {
      case "load-project":
        await workspaceService.loadProject(
          request.requestId,
          request.rootPath,
          request.globalEnvVars,
          request.wslGitByWorktree,
          request.forgeProviderOverride !== undefined ||
            request.forgeDefaultProviderId !== undefined ||
            request.forgeRemote !== undefined
            ? {
                forgeProviderOverride: request.forgeProviderOverride ?? null,
                forgeDefaultProviderId: request.forgeDefaultProviderId ?? null,
                forgeRemote: request.forgeRemote ?? null,
              }
            : undefined
        );
        break;

      case "update-forge-settings":
        workspaceService.updateForgeSettings({
          forgeProviderOverride: request.forgeProviderOverride,
          forgeDefaultProviderId: request.forgeDefaultProviderId,
          forgeRemote: request.forgeRemote,
        });
        break;

      case "set-wsl-opt-in":
        workspaceService.setWslOptIn(request.worktreeId, request.enabled, request.dismissed);
        break;

      case "reprobe-wsl":
        void workspaceService.reprobeWslForWorktree(request.worktreeId);
        break;

      case "sync":
        try {
          await workspaceService.syncMonitors(
            request.worktrees,
            request.activeWorktreeId,
            request.mainBranch,
            request.monitorConfig
          );
          sendEvent({ type: "sync-result", requestId: request.requestId, success: true });
        } catch (error) {
          sendEvent({
            type: "sync-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "project-switch":
        await workspaceService.onProjectSwitch(request.requestId);
        break;

      case "get-all-states":
        workspaceService.getAllStates(request.requestId);
        break;

      case "get-monitor":
        workspaceService.getMonitor(request.requestId, request.worktreeId);
        break;

      case "set-active":
        workspaceService.setActiveWorktree(request.requestId, request.worktreeId, {
          silent: request.silent,
        });
        break;

      case "refresh":
        await workspaceService.refresh(request.requestId, request.worktreeId);
        break;

      case "refresh-on-wake":
        await workspaceService.refreshOnWake(request.requestId);
        break;

      case "refresh-prs":
        {
          const { pullRequestService } = await import("./services/PullRequestService.js");
          try {
            await pullRequestService.refresh();
            sendEvent({ type: "refresh-prs-result", requestId: request.requestId, success: true });
          } catch (error) {
            sendEvent({
              type: "refresh-prs-result",
              requestId: request.requestId,
              success: false,
              error: (error as Error).message,
            });
          }
        }
        break;

      case "get-pr-status":
        workspaceService.getPRStatus(request.requestId);
        break;

      case "reset-pr-state":
        workspaceService.resetPRState(request.requestId);
        break;

      case "create-worktree":
        await workspaceService.createWorktree(request.requestId, request.rootPath, request.options);
        break;

      case "delete-worktree":
        await workspaceService.deleteWorktree(
          request.requestId,
          request.worktreeId,
          request.force,
          request.deleteBranch
        );
        break;

      case "list-branches":
        await workspaceService.listBranches(request.requestId, request.rootPath);
        break;

      case "get-recent-branches":
        await workspaceService.getRecentBranches(request.requestId, request.rootPath);
        break;

      case "fetch-pr-branch":
        await workspaceService.fetchPRBranch(
          request.requestId,
          request.rootPath,
          request.prNumber,
          request.headRefName
        );
        break;

      case "get-file-diff":
        await workspaceService.getFileDiff(
          request.requestId,
          request.cwd,
          request.filePath,
          request.status,
          request.ignoreWhitespace
        );
        break;

      case "set-polling-enabled":
        workspaceService.setPollingEnabled(request.enabled);
        break;

      case "set-pr-poll-cadence":
        {
          const { pullRequestService } = await import("./services/PullRequestService.js");
          // Disable enrichment before slowing the cadence so there's no window
          // where the expensive CI fetch still fires at the new blurred rate.
          pullRequestService.setCIEnrichmentEnabled(request.focused);
          pullRequestService.setFocusCadence(request.focused);
        }
        break;

      // Pace background fetch cadence against the GraphQL budget observed in
      // main (where all forge HTTP calls live post-#8870) so multiple
      // instances drawing on the same per-user token budget back off in step
      // as it depletes — and snap back when it resets.
      case "apply-fetch-throttle":
        workspaceService.applyFetchThrottle(request.multiplier);
        break;

      // Provider hostname-matcher table relayed from main's forge registry.
      // Arrives async after plugin load (and again on registry changes), so
      // the service re-evaluates running monitors' matched provider ids.
      case "forge-provider-matchers":
        workspaceService.setForgeProviderMatchers(request.matchers);
        break;

      case "background":
        workspaceService.pause();
        break;

      case "foreground":
        workspaceService.resume();
        break;

      case "health-check":
        sendEvent({ type: "pong" });
        break;

      case "dispose":
        shutdownController.abort();
        workspaceService.dispose();
        // Reject any pending forge calls so awaiting code paths fail fast
        // instead of waiting on the 30s timeout. Late `forge:rpc-result`
        // messages after this are still safe — `handleResult` drops unknown
        // ids — but eagerly clearing the pending map prevents shutdown delays.
        forgeBridge.dispose();
        break;

      case "set-log-level-overrides": {
        const overrides = (request.overrides ?? {}) as Record<string, unknown>;
        const sanitized: Record<string, string> = {};
        for (const [key, value] of Object.entries(overrides)) {
          if (typeof key === "string" && typeof value === "string") {
            sanitized[key] = value;
          }
        }
        setLogLevelOverrides(sanitized);
        break;
      }

      case "copytree:generate": {
        const { requestId, operationId, rootPath, options } = request;
        console.log(`[WorkspaceHost] CopyTree generate started: ${operationId}`);

        const onProgress = (progress: CopyTreeProgress) => {
          sendEvent({
            type: "copytree:progress",
            operationId,
            progress,
          });
        };

        try {
          const result = await copytreeWorkerClient.generate(
            rootPath,
            options || {},
            onProgress,
            operationId
          );
          sendEvent({
            type: "copytree:complete",
            requestId,
            operationId,
            result,
          });
        } catch (error) {
          sendEvent({
            type: "copytree:error",
            requestId,
            operationId,
            error: (error as Error).message,
          });
        }
        break;
      }

      case "copytree:cancel":
        copytreeWorkerClient.cancel(request.operationId);
        break;

      // Worker-governance pull: copytree worker state + this host's memory.
      // The copytree worker is a worker_thread inside this utility process,
      // so host-level memoryUsage() is the pool's memory attribution.
      case "governance:snapshot": {
        const memory = process.memoryUsage();
        sendEvent({
          type: "governance:snapshot-result",
          requestId: request.requestId,
          snapshot: {
            timestamp: Date.now(),
            workers: [copytreeWorkerClient.getGovernanceSnapshot()],
            hostMemory: {
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              externalBytes: memory.external ?? 0,
            },
          },
        });
        break;
      }

      case "copytree:test-config": {
        const { requestId, operationId, rootPath, options } = request;
        console.log(`[WorkspaceHost] CopyTree test-config started`);

        try {
          const result = await copytreeWorkerClient.testConfig(
            rootPath,
            options || {},
            operationId
          );
          sendEvent({
            type: "copytree:test-config-result",
            requestId,
            result,
          });
        } catch (error) {
          sendEvent({
            type: "copytree:test-config-result",
            requestId,
            result: {
              includedFiles: 0,
              includedSize: 0,
              excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
              error: formatErrorMessage(error, "Failed to test CopyTree config"),
            },
          });
        }
        break;
      }

      case "update-monitor-config":
        try {
          workspaceService.updateMonitorConfig(request.config);
          sendEvent({
            type: "update-monitor-config-result",
            requestId: request.requestId,
            success: true,
          });
        } catch (error) {
          sendEvent({
            type: "update-monitor-config-result",
            requestId: request.requestId,
            success: false,
            error: (error as Error).message,
          });
        }
        break;

      case "update-forge-credentials":
        workspaceService.updateForgeCredentials(request.providerId, request.credentials);
        break;

      case "forge:provider-registry-updated":
        workspaceService.notifyForgeProviderRegistryUpdated();
        break;

      case "retry-auth-fetch":
        workspaceService.retryAuthFetch();
        break;

      case "get-file-tree": {
        const { requestId, worktreePath, dirPath } = request;
        try {
          const nodes = await fileTreeService.getFileTree(worktreePath, dirPath);
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes,
          });
        } catch (error) {
          sendEvent({
            type: "file-tree-result",
            requestId,
            nodes: [],
            error: (error as Error).message,
          });
        }
        break;
      }

      case "git:get-project-pulse": {
        const {
          requestId,
          worktreePath,
          worktreeId,
          mainBranch,
          rangeDays,
          includeDelta,
          includeRecentCommits,
          forceRefresh,
        } = request;
        try {
          if (typeof worktreePath !== "string" || !worktreePath.trim()) {
            throw new Error("Invalid worktreePath");
          }
          if (typeof worktreeId !== "string" || !worktreeId.trim()) {
            throw new Error("Invalid worktreeId");
          }
          if (typeof mainBranch !== "string" || !mainBranch.trim()) {
            throw new Error("Invalid mainBranch");
          }
          if (![60, 120, 180].includes(rangeDays)) {
            throw new Error("Invalid rangeDays");
          }
          if (includeDelta !== undefined && typeof includeDelta !== "boolean") {
            throw new Error("Invalid includeDelta");
          }
          if (includeRecentCommits !== undefined && typeof includeRecentCommits !== "boolean") {
            throw new Error("Invalid includeRecentCommits");
          }
          if (forceRefresh !== undefined && typeof forceRefresh !== "boolean") {
            throw new Error("Invalid forceRefresh");
          }

          const pulse = await projectPulseService.getPulse({
            worktreePath,
            worktreeId,
            mainBranch,
            rangeDays,
            includeDelta,
            includeRecentCommits,
            forceRefresh,
          });
          sendEvent({
            type: "git:project-pulse",
            requestId,
            data: pulse,
          });
        } catch (error) {
          sendEvent({
            type: "git:project-pulse-error",
            requestId,
            error: (error as Error).message,
          });
        }
        break;
      }

      case "invalidate-pulse-cache": {
        if (typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
          console.warn("[WorkspaceHost] invalidate-pulse-cache: invalid worktreeId");
          break;
        }
        projectPulseService.invalidate(request.worktreeId);
        break;
      }

      // Inbound result for a forge RPC the bridge dispatched earlier — route
      // to the pending promise keyed by `forgeRequestId`. The bridge owns
      // success/error semantics and any timeout cleanup; main just hands the
      // raw envelope across.
      case "forge:rpc-result":
        forgeBridge.handleResult(request);
        break;

      default:
        console.warn("[WorkspaceHost] Unknown message type:", (request as any).type);
    }
  } catch (error) {
    console.error("[WorkspaceHost] Error handling message:", error);
    sendEvent({ type: "error", error: (error as Error).message });
  }
});

// Graceful shutdown on SIGTERM (macOS/Linux; Windows uses TerminateProcess so this won't fire)
process.on("SIGTERM", () => {
  console.log("[WorkspaceHost] SIGTERM received, shutting down");
  shutdownController.abort();
  workspaceService.dispose();
  forgeBridge.dispose();
});

// Signal ready
console.log("[WorkspaceHost] Initialized and ready");
markHostPerformance(PERF_MARKS.WORKSPACE_HOST_READY_POSTED);
sendEvent({ type: "ready" });
