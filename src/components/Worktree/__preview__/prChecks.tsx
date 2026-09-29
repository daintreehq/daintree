import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GitBranch } from "lucide-react";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UI_TOOLTIP_DELAY_DURATION, UI_TOOLTIP_SKIP_DELAY_DURATION } from "@/lib/animationUtils";
import { PrStatusChip } from "../ReviewHub/PrStatusChip";
import type { CIStatusState } from "@shared/types/forge";
import type { ForgeCheckRun } from "@shared/types/ipc/forge";
import "@/index.css";

/**
 * Standalone visual-review harness for the Review Hub's PR status chip and the
 * CI checks popover it opens.
 *
 * Mounts the REAL `PrStatusChip` (and through it the real `PrChecksPopover`)
 * inside a copy of the Review Hub header row. The bridge answers
 * `forge.getChecks` from a fixture — a list, `null` for "no such PR", a
 * rejection, or a promise that never settles — which is the same seam
 * `forgeClient.getChecks` reads in the app. The header around the chip is
 * harness decoration.
 *
 * Query parameters:
 *   ?theme=<built-in theme id>
 *   ?fixture=<name>   one of FIXTURES below
 */

const WORKTREE_PATH = "/Users/greg/Projects/helios-worktrees/fix-upload-retry-after";
const PR_NUMBER = 4830;
const PR_URL = `https://github.com/helios/dashboard/pull/${PR_NUMBER}`;
const RUN = (id: number) => `https://github.com/helios/dashboard/actions/runs/${id}`;

type Reply = ForgeCheckRun[] | "missing" | "error" | "pending";

interface Fixture {
  ci?: CIStatusState;
  checks: Reply;
}

const done = (
  name: string,
  conclusion: ForgeCheckRun["conclusion"],
  extra: Partial<ForgeCheckRun> = {}
): ForgeCheckRun => ({
  name,
  status: "completed",
  conclusion,
  detailsUrl: RUN(9_100_000 + name.length * 7919),
  ...extra,
});

const MIXED: ForgeCheckRun[] = [
  done("lint", "success", { required: true }),
  done("typecheck", "success", { required: true }),
  done("test (ubuntu-latest, shard 2/4)", "failure", { required: true }),
  done("test (ubuntu-latest, shard 1/4)", "success", { required: true }),
  done("test (ubuntu-latest, shard 3/4)", "success", { required: true }),
  done("test (ubuntu-latest, shard 4/4)", "success", { required: true }),
  done("build (macos-14, arm64, electron-builder --publish never)", "timed_out", {
    required: false,
  }),
  { name: "smoke (linux)", status: "in_progress", detailsUrl: RUN(9_200_001), required: true },
  { name: "e2e nightly", status: "queued", required: false },
  done("changelog", "skipped", { required: false }),
  done("ci-ok", "success", { required: true }),
];

const PASSING: ForgeCheckRun[] = [
  done("lint", "success", { required: true }),
  done("typecheck", "success", { required: true }),
  done("test (ubuntu-latest, shard 1/4)", "success", { required: true }),
  done("test (ubuntu-latest, shard 2/4)", "success", { required: true }),
  done("build", "success", { required: true }),
  done("changelog", "skipped", { required: false }),
];

const RUNNING: ForgeCheckRun[] = [
  done("lint", "success", { required: true }),
  done("typecheck", "success", { required: true }),
  { name: "test (ubuntu-latest, shard 1/4)", status: "in_progress", required: true },
  { name: "test (ubuntu-latest, shard 2/4)", status: "in_progress", required: true },
  { name: "build", status: "queued", required: true },
];

const MANY: ForgeCheckRun[] = [
  done("security / CodeQL (javascript-typescript)", "action_required"),
  done("deploy-preview", "cancelled"),
  done("test (windows-latest, shard 3/4)", "failure"),
  ...Array.from({ length: 22 }, (_, i) =>
    done(
      `test (${i % 2 ? "ubuntu" : "macos"}-latest, node ${20 + (i % 3)}, shard ${i + 1}/22)`,
      "success"
    )
  ),
  { name: "status-report", status: "completed" },
];

export const FIXTURES: Record<string, Fixture> = {
  mixed: { ci: "failure", checks: MIXED },
  passing: { ci: "success", checks: PASSING },
  running: { ci: "pending", checks: RUNNING },
  many: { ci: "failure", checks: MANY },
  empty: { ci: undefined, checks: [] },
  missing: { ci: "unknown", checks: "missing" },
  error: { ci: "failure", checks: "error" },
  loading: { ci: "pending", checks: "pending" },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const fixtureName = params.get("fixture") ?? "mixed";
const requested = FIXTURES[fixtureName];
if (!requested) {
  throw new Error(`unknown fixture "${fixtureName}" — one of ${FIXTURE_NAMES.join(", ")}`);
}
const fixture: Fixture = requested;

function getChecks(): Promise<{ checks: ForgeCheckRun[] } | null> {
  const reply = fixture.checks;
  if (reply === "pending") return new Promise(() => undefined);
  if (reply === "error") return Promise.reject(new Error("GitHub API request failed (502)"));
  if (reply === "missing") return Promise.resolve(null);
  return Promise.resolve({ checks: reply });
}

installPreviewShims({
  forge: new Proxy(
    { getChecks },
    {
      get: (target, key) =>
        key in target ? Reflect.get(target, key) : () => Promise.resolve(undefined),
    }
  ),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(themeId));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

function ciStatus(state: CIStatusState | undefined) {
  if (!state) return undefined;
  return { state, total: 11, passed: 7, failed: 2, pending: 2, rawData: {} };
}

/** Copy of the Review Hub header row — harness decoration around the real chip. */
function Preview() {
  return (
    <div
      data-preview-shell
      className="w-[720px] border border-divider"
      style={{ background: "var(--color-surface-panel)" }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-divider">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-text-primary font-semibold text-sm tracking-wide shrink-0">
            Review & commit
          </h2>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-tint/[0.07] border border-tint/[0.08] text-2xs text-text-secondary font-mono truncate max-w-[200px]">
            <GitBranch className="w-3 h-3 shrink-0" />
            <span className="truncate">fix/upload-retry-after</span>
          </span>
          <PrStatusChip
            hasRemote
            worktreePR={{
              prNumber: PR_NUMBER,
              prUrl: PR_URL,
              prState: "open",
              prCiStatus: ciStatus(fixture.ci),
            }}
            worktreePath={WORKTREE_PATH}
            onOpenExternal={() => undefined}
          />
        </div>
      </div>
      <div className="h-[420px]" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider
      delayDuration={UI_TOOLTIP_DELAY_DURATION}
      skipDelayDuration={UI_TOOLTIP_SKIP_DELAY_DURATION}
      disableHoverableContent
    >
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
