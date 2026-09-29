import "@/lib/trustedTypesPolicy";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import type { ArtifactDetectedPayload, StagingStatus } from "@shared/types";
import type { CrossWorktreeDiffResult } from "@shared/types/ipc/git";
import type { DevPreviewDiagnosticsResult } from "@shared/types/ipc/devPreview";

/**
 * Bridge answers for the surface-headers harness. Imported FIRST by the preview so
 * the shim is on `window` before any store module evaluates.
 *
 * `installPreviewShims` is first-call-wins, so this is the one shim for every shot:
 * the namespaces a surface reads on mount answer with fixtures, and every other
 * method stays inert — a value that is both awaitable and a no-op unsubscribe.
 */

export const REPO_ROOT = "/Users/dev/acme-platform";
export const FEATURE_PATH = "/Users/dev/acme-platform-worktrees/feature-auth-refresh";
export const FEATURE_BRANCH = "feature/auth-refresh";

function inert(): unknown {
  const settled = Promise.resolve(undefined);
  return Object.assign(() => undefined, {
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  });
}

function withFallback(methods: Record<string, (...args: never[]) => unknown>): unknown {
  return new Proxy(methods, {
    get: (target, key) => (key in target ? Reflect.get(target, key) : () => inert()),
  });
}

const unsubscribe = () => () => undefined;

export const STAGING_STATUS: StagingStatus = {
  staged: [
    { path: "src/auth/session.ts", status: "modified", insertions: 24, deletions: 9 },
    { path: "src/auth/tokens.ts", status: "modified", insertions: 11, deletions: 3 },
  ],
  unstaged: [
    {
      path: "src/auth/__tests__/session.test.ts",
      status: "modified",
      insertions: 38,
      deletions: 2,
    },
    { path: "src/auth/refreshQueue.ts", status: "added", insertions: 57, deletions: 0 },
    { path: "docs/auth.md", status: "modified", insertions: 6, deletions: 1 },
  ],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: FEATURE_BRANCH,
  hasRemote: true,
  pushDestination: { remote: "origin", branch: FEATURE_BRANCH },
  pullSource: { remote: "origin", branch: FEATURE_BRANCH },
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
};

const COMPARISON: CrossWorktreeDiffResult = {
  branch1: "main",
  branch2: FEATURE_BRANCH,
  files: [
    { path: "src/auth/session.ts", status: "M", insertions: 24, deletions: 9 },
    { path: "src/auth/refreshQueue.ts", status: "A", insertions: 57, deletions: 0 },
  ],
};

const NOW = Date.now();

const DIAGNOSTICS: DevPreviewDiagnosticsResult = {
  session: {
    panelId: "surface-dev-preview",
    projectId: "proj-acme",
    status: "running",
    generation: 2,
    updatedAt: NOW,
    allocatedPort: 5173,
    detectedUrl: "http://localhost:5173",
    upstream: { kind: "ok", port: 5173, isHttps: false },
    crashLoop: { count: 0, stopped: false, backoffPending: false },
    restoredFromManifest: false,
    events: [
      {
        type: "proxy-502",
        at: NOW - 30_000,
        seq: 0,
        generation: 1,
        cause: "upstream-refused",
        count: 7,
      },
      {
        type: "url-detected",
        at: NOW - 20_000,
        seq: 1,
        generation: 1,
        url: "http://localhost:5173",
      },
    ],
  },
  proxy: { port: 43_000, usedPortFallback: false },
};

let detected: ((payload: ArtifactDetectedPayload) => void) | null = null;

/** Deliver artifacts the way the main process does: through the overlay's own subscription. */
export function emitArtifactsDetected(payload: ArtifactDetectedPayload): boolean {
  if (!detected) return false;
  detected(payload);
  return true;
}

const isHarness = !Reflect.get(window, "electron");

installPreviewShims({
  artifact: withFallback({
    onDetected: (callback: (payload: ArtifactDetectedPayload) => void) => {
      detected = callback;
      return () => {
        if (detected === callback) detected = null;
      };
    },
  }),
  git: withFallback({
    getStagingStatus: () => Promise.resolve(STAGING_STATUS),
    compareWorktrees: (...args: never[]) =>
      // A file argument asks for one file's diff text; without one it is the file list.
      Promise.resolve((args as unknown[])[3] ? "" : COMPARISON),
    listCommits: () => Promise.resolve({ items: [], hasMore: false, total: 0 }),
    listRemoteCommits: () => Promise.resolve([]),
    scanConflictMarkers: () => Promise.resolve([]),
    onPushProgress: unsubscribe,
  }),
  worktreePort: withFallback({ onEvent: unsubscribe }),
  plugin: withFallback({
    list: () => Promise.resolve([]),
    getDiagnosticsSnapshot: () => Promise.resolve({ plugins: [] }),
    getRuntimeStatuses: () => Promise.resolve([]),
    getDecorations: () => Promise.resolve({}),
    onDecorationsChanged: unsubscribe,
  }),
  pluginMcp: withFallback({ list: () => Promise.resolve([]) }),
  mcpServer: withFallback({
    getPaneNotifyState: () => Promise.resolve(null),
    getAuditRecords: () => Promise.resolve([]),
  }),
  devPreview: withFallback({ getDiagnostics: () => Promise.resolve(DIAGNOSTICS) }),
});

// A harness page must never inherit persisted state from an earlier page load.
if (isHarness) {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // Storage can be unavailable; the harness renders without it.
  }
}
