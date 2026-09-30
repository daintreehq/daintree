import type { FileChangeDetail } from "@shared/types/git";
import type { SubmoduleDeleteRisk } from "@shared/types/submodule";
import type { WorktreeTeardownPreview } from "@shared/types/worktree";
import type { WorktreeDeletePreview } from "../worktreeDeletePreview";
import {
  isBulkRemoveEligible,
  isBulkRemoveRetryable,
  type BulkRemoveTarget,
  type BulkRemoveTargetStatus,
  type UseWorktreeBulkRemoveReturn,
} from "../useWorktreeBulkRemove";
import { pluralize } from "@/lib/pluralize";

/**
 * Hook snapshots for the bulk-remove confirm's visual-review harness. The
 * dialog is a pure function of `UseWorktreeBulkRemoveReturn`, so each state is
 * a snapshot of that value rather than a scripted run of the real fan-out.
 */

const ROOT = "/Users/dev/helios-worktrees";

function change(rel: string, status: FileChangeDetail["status"], wt: string): FileChangeDetail {
  return { path: `${ROOT}/${wt}/${rel}`, status, insertions: null, deletions: null };
}

function risk(over: Partial<SubmoduleDeleteRisk> = {}): SubmoduleDeleteRisk {
  return {
    entries: [],
    dirtyFiles: [],
    untrackedFiles: [],
    atRiskCommits: [],
    requiresMechanicalForce: false,
    incomplete: false,
    ...over,
  };
}

function verified(wt: string, over: Partial<WorktreeDeletePreview> = {}): BulkRemoveTargetStatus {
  const changes = over.changes ?? [];
  const tracked = changes.filter((c) => c.status !== "untracked" && c.status !== "ignored").length;
  const untracked = changes.filter((c) => c.status === "untracked").length;
  return {
    state: "verified",
    preview: {
      trackedChangeCount: tracked,
      untrackedFileCount: untracked,
      hasTrackedChanges: tracked > 0,
      hasUntrackedFiles: untracked > 0,
      changes,
      rootPath: `${ROOT}/${wt}`,
      submodules: { status: "verified", risk: risk() },
      ahead: 0,
      ...over,
    },
  };
}

function target(branch: string, over: Partial<BulkRemoveTarget> = {}): BulkRemoveTarget {
  const wt = branch.replace(/\//g, "-");
  return {
    id: wt,
    name: wt,
    branch,
    path: `${ROOT}/${wt}`,
    aheadCount: 0,
    status: verified(wt),
    teardown: null,
    ...over,
  };
}

const TEARDOWN: WorktreeTeardownPreview = {
  phases: [
    {
      phase: "teardown",
      approved: true,
      commands: ["docker compose -p helios-retry-backoff down -v", "rm -rf .cache/playwright"],
    },
  ],
};

const TEARDOWN_UNAPPROVED: WorktreeTeardownPreview = {
  phases: [
    { phase: "resource-teardown", approved: false, commands: ["./scripts/release-ports.sh"] },
    { phase: "teardown", approved: true, commands: ["npm run db:drop -- --force"] },
  ],
};

const clean = target("feature/streaming-uploads", { teardown: TEARDOWN });

const dirty = target("fix/retry-backoff-jitter", {
  aheadCount: 2,
  teardown: TEARDOWN,
  status: verified("fix-retry-backoff-jitter", {
    ahead: 2,
    changes: [
      change("src/retry.ts", "modified", "fix-retry-backoff-jitter"),
      change("src/queue.ts", "modified", "fix-retry-backoff-jitter"),
      change("src/index.ts", "deleted", "fix-retry-backoff-jitter"),
      change("src/jitter.ts", "untracked", "fix-retry-backoff-jitter"),
      change(".env.local", "untracked", "fix-retry-backoff-jitter"),
    ],
    submodules: {
      status: "verified",
      risk: risk({
        dirtyFiles: ["vendor/proto/schema/events.proto"],
        untrackedFiles: ["vendor/proto/gen/events_pb.ts"],
      }),
    },
  }),
});

const untrackedOnly = target("chore/bump-electron", {
  status: verified("chore-bump-electron", {
    changes: [
      change("notes.md", "untracked", "chore-bump-electron"),
      change("electron-42.log", "untracked", "chore-bump-electron"),
    ],
  }),
});

const blocked = target("feature/proto-v2-events", {
  status: verified("feature-proto-v2-events", {
    submodules: {
      status: "verified",
      risk: risk({
        atRiskCommits: [
          {
            oid: "9f2c4e1a7b3d5f60812c4e6a8b0d2f4a6c8e0b1d",
            subject: "Add EventEnvelope v2 with trace context",
            submodulePaths: ["vendor/proto"],
          },
          {
            oid: "3b7d9f1c5e2a4b6d8f0a2c4e6b8d0f2a4c6e8a0b",
            subject: "Deprecate legacy span fields",
            submodulePaths: ["vendor/proto"],
          },
        ],
      }),
    },
  }),
});

const verifyFailed = target("spike/wasm-image-resize", {
  status: { state: "failed", submodules: null },
});

const pendingOf = (t: BulkRemoveTarget): BulkRemoveTarget => ({
  ...t,
  status: { state: "pending" },
  teardown: undefined,
});

const LONG_BRANCH = "feature/observability-pipeline-opentelemetry-span-exporter-backpressure";
const longTarget = target(LONG_BRANCH, {
  teardown: TEARDOWN_UNAPPROVED,
  status: verified(LONG_BRANCH.replace(/\//g, "-"), {
    changes: Array.from({ length: 9 }, (_, i) =>
      change(
        `packages/telemetry-exporter/src/internal/span-exporter-backpressure-strategy-${i}.ts`,
        i < 3 ? "modified" : "untracked",
        LONG_BRANCH.replace(/\//g, "-")
      )
    ),
  }),
});

const unreadableTeardown = target("chore/rename-metrics-labels", {
  teardown: "unreadable",
  status: verified("chore-rename-metrics-labels", {
    changes: [change("src/metrics.ts", "modified", "chore-rename-metrics-labels")],
  }),
});

function snapshot(
  targets: BulkRemoveTarget[],
  over: Partial<UseWorktreeBulkRemoveReturn> = {}
): UseWorktreeBulkRemoveReturn {
  const eligibleCount = targets.filter(isBulkRemoveEligible).length;
  const isPreviewPending = targets.some((t) => t.status.state === "pending");
  const noop = () => {};
  return {
    isConfirmOpen: true,
    targets,
    excludedMainCount: 0,
    excludedMainNames: [],
    isRechecking: false,
    eligibleCount,
    isPreviewPending,
    hasRetryablePreviews: targets.some(isBulkRemoveRetryable),
    isRetryingPreviews: false,
    consentKey: `1:${isPreviewPending ? "pending" : "settled"}`,
    typedNameTarget: pluralize(eligibleCount, "worktree"),
    canConfirm: !isPreviewPending && eligibleCount > 0,
    isExecuting: false,
    handleRemoveClick: noop,
    handleRetryPreviews: noop,
    handleConfirm: async () => {},
    handleCancel: noop,
    ...over,
  };
}

export interface BulkRemoveFixture {
  value: UseWorktreeBulkRemoveReturn;
  /** Type the gate's target before the capture. */
  typeGate?: boolean;
  /** What the capture must show before it is written. */
  expectText: string;
}

export const BULK_REMOVE_FIXTURES = {
  pending: {
    value: snapshot([clean, dirty, untrackedOnly].map(pendingOf)),
    expectText: "Remove 3 worktrees?",
  },
  mixed: {
    value: snapshot([clean, dirty, untrackedOnly, blocked, verifyFailed], {
      excludedMainCount: 1,
      excludedMainNames: ["main"],
    }),
    expectText: "Remove 3 worktrees?",
  },
  "mixed-typed": {
    value: snapshot([clean, dirty, untrackedOnly, blocked, verifyFailed], {
      excludedMainCount: 1,
      excludedMainNames: ["main"],
    }),
    typeGate: true,
    expectText: "Remove 3 worktrees?",
  },
  "all-clean": {
    value: snapshot([
      target("feature/streaming-uploads"),
      target("docs/api-rate-limits"),
      target("chore/lint-staged"),
    ]),
    expectText: "Remove 3 worktrees?",
  },
  single: {
    value: snapshot([dirty, blocked]),
    expectText: "Remove 'fix/retry-backoff-jitter'?",
  },
  "all-excluded": {
    value: snapshot([blocked, verifyFailed]),
    expectText: "Nothing left to remove",
  },
  retrying: {
    value: snapshot([clean, pendingOf(verifyFailed)], { isRetryingPreviews: true }),
    expectText: "Remove 2 worktrees?",
  },
  long: {
    value: snapshot([longTarget, unreadableTeardown, dirty]),
    expectText: "Remove 3 worktrees?",
  },
  executing: {
    value: snapshot([clean, dirty], { isExecuting: true }),
    typeGate: true,
    expectText: "Remove 2 worktrees?",
  },
} satisfies Record<string, BulkRemoveFixture>;

export type BulkRemoveFixtureName = keyof typeof BULK_REMOVE_FIXTURES;

export function isBulkRemoveFixtureName(name: string): name is BulkRemoveFixtureName {
  return Object.hasOwn(BULK_REMOVE_FIXTURES, name);
}

export const BULK_REMOVE_FIXTURE_NAMES: BulkRemoveFixtureName[] =
  Object.keys(BULK_REMOVE_FIXTURES).filter(isBulkRemoveFixtureName);
