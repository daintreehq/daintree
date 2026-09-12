import { usePanelStore } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { useForgeProviderHealthStore } from "@/store/forgeProviderHealthStore";
import { useCloudSyncBannerStore } from "@/store/cloudSyncBannerStore";
import { useRosettaBannerStore } from "@/store/rosettaBannerStore";
import { useHostMemoryPauseStore } from "@/store/hostMemoryPauseStore";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { pluginDocumentRuntime } from "@/services/plugin/pluginDocumentRuntime";
import type { GlobalBannerSlot } from "../useGlobalBannerPriority";
import type { PrerequisiteCheckResult } from "@shared/types";

/**
 * Seeds for the visual-review harness — every state of every global banner,
 * pushed through the stores the banners actually read. No prop-level mocks:
 * the banner components are the real ones, and so is what they subscribe to.
 *
 * `slot` names which coordinator slot the seed claims, so the single-banner
 * page can render through `GlobalBannerCoordinator` and prove the priority
 * hook resolves to it; the comparison sheet seeds everything at once and
 * mounts each banner directly, since only one can ever hold the slot.
 */
export interface BannerFixture {
  slot: Exclude<GlobalBannerSlot, null>;
  /** What this state is here to prove. */
  what: string;
  seed: () => void;
  /** Extra settle time after seeding — the Doherty-gated variants need it. */
  settleMs?: number;
}

const GIT_MISSING: PrerequisiteCheckResult = {
  tool: "git",
  label: "Git",
  available: false,
  unavailableReason: "not-found",
  version: null,
  severity: "fatal",
  meetsMinVersion: false,
  installUrl: "https://git-scm.com/downloads",
  installBlocks: {
    macos: [{ label: "Homebrew", commands: ["brew install git"] }],
    linux: [{ label: "apt", commands: ["sudo apt install git"] }],
    windows: [{ label: "winget", commands: ["winget install Git.Git"] }],
  },
};

const NODE_OUTDATED: PrerequisiteCheckResult = {
  tool: "node",
  label: "Node.js",
  available: true,
  version: "18.20.4",
  severity: "fatal",
  meetsMinVersion: false,
  minVersion: "22.0.0",
  installUrl: "https://nodejs.org/en/download",
};

function seedForgeToken(withReauth: boolean) {
  const store = useForgeProviderHealthStore.getState();
  store.setProviderMeta("github", { providerName: "GitHub", pluginId: null });
  store.setTokenUnhealthy("github", true, {
    status: "unhealthy",
    tokenVersion: 1,
    checkedAt: Date.now(),
    reauthUrl: withReauth ? "https://github.com/settings/tokens" : undefined,
  });
}

/** A plugin package that fails to import is the smallest real diagnostic the runtime emits. */
function seedPluginDocument() {
  pluginDocumentRuntime.registerView("acme.markdown", "plugin://acme-markdown/view.js");
  void pluginDocumentRuntime
    .load("plugin://acme-markdown/view.js", {
      name: "@acme/markdown-editor",
      version: "1.4.0",
      buildId: "a".repeat(64),
      entryUrl: "/document.js",
    })
    .catch(() => undefined);
}

export const BANNER_FIXTURES = {
  "host-crash": {
    slot: "host-crash",
    what: "backend gone after three restarts — the one blocking error in the family",
    seed: () => {
      usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "OUT_OF_MEMORY" });
    },
  },
  "host-crash-diagnostics-failed": {
    slot: "host-crash",
    what: "the secondary affordance failed and has to say so inside the banner",
    seed: () => {
      usePanelStore.setState({ backendStatus: "disconnected", lastCrashType: "UNKNOWN_CRASH" });
      useDiagnosticsReviewStore.setState({
        downloadError: "Log directory is not readable (EACCES)",
      });
    },
  },
  "host-crash-recovering": {
    slot: "host-crash",
    what: "auto-restart in flight — shown only past the 400ms Doherty gate",
    seed: () => {
      usePanelStore.setState({ backendStatus: "recovering", lastCrashType: "UNKNOWN_CRASH" });
    },
    settleMs: 600,
  },
  "watchdog-disabled": {
    slot: "watchdog-disabled",
    what: "the deadlock detector gave up; the backend itself is fine",
    seed: () => {
      usePanelStore.setState({
        watchdogStatus: "disabled",
        watchdogDisabledInfo: { attemptCount: 3, lastExitCode: 1, timestamp: Date.now() },
      });
    },
  },
  "host-memory-stall": {
    slot: "host-memory-stall",
    what: "a memory pause that is not recovering — not dismissible, self-clearing",
    seed: () => {
      useHostMemoryPauseStore.setState({
        snapshot: { active: true, paused: true, stalled: true },
        visible: true,
      });
    },
  },
  "safe-mode": {
    slot: "safe-mode",
    what: "panels withheld after a crash loop; details live behind a popover",
    seed: () => {
      useSafeModeStore.getState().setSafeMode(true, {
        crashCount: 3,
        skippedPanelCount: 4,
        lastCrashAt: Date.now() - 4 * 60_000,
        quarantinedPanels: [
          {
            id: "p1",
            kind: "terminal",
            title: "claude — feature/issue-12100-diff-pane",
            worktreeId: "feature/issue-12100-diff-pane",
          },
          { id: "p2", kind: "browser", title: "", cwd: "/Users/dev/Projects/daintree" },
        ],
      });
    },
  },
  "restore-confirmation": {
    slot: "restore-confirmation",
    what: "the reassurance — nothing is wrong, the session came back",
    seed: () => {
      useRestoreConfirmationStore.getState().showRestoreConfirmation({
        suspectCount: 0,
        crashCount: 1,
      });
    },
  },
  "restore-confirmation-suspects": {
    slot: "restore-confirmation",
    what: "the reassurance with a caveat: some panels may be implicated",
    seed: () => {
      useRestoreConfirmationStore.getState().showRestoreConfirmation({
        suspectCount: 3,
        crashCount: 2,
      });
    },
  },
  "missing-prerequisite": {
    slot: "missing-prerequisite",
    what: "git absent, install command on offer",
    seed: () => {
      useMissingPrerequisiteStore.getState().setMissing([GIT_MISSING]);
    },
  },
  "missing-prerequisite-outdated": {
    slot: "missing-prerequisite",
    what: "the tool exists but is too old — a different sentence, same banner",
    seed: () => {
      useMissingPrerequisiteStore.getState().setMissing([NODE_OUTDATED]);
    },
  },
  "missing-prerequisite-installing": {
    slot: "missing-prerequisite",
    what: "install running; the context line carries the package manager's output",
    seed: () => {
      useMissingPrerequisiteStore.getState().setMissing([GIT_MISSING]);
      useMissingPrerequisiteStore.getState().setInstall({
        jobId: "job-1",
        tool: "git",
        status: "running",
        statusLine: "==> Downloading https://ghcr.io/v2/homebrew/core/git/manifests/2.47.1",
        error: null,
      });
    },
  },
  "missing-prerequisite-failed": {
    slot: "missing-prerequisite",
    what: "install failed — the only other error-severity member of the family",
    seed: () => {
      useMissingPrerequisiteStore.getState().setMissing([GIT_MISSING]);
      useMissingPrerequisiteStore.getState().setInstall({
        jobId: "job-1",
        tool: "git",
        status: "error",
        statusLine: "",
        error: "Error: Homebrew requires macOS 13 or newer",
      });
    },
  },
  "forge-token": {
    slot: "forge-token",
    what: "expired credentials with a reauthorization link — the two-action case",
    seed: () => seedForgeToken(true),
  },
  "forge-token-single": {
    slot: "forge-token",
    what: "expired credentials, no reauth URL — one action",
    seed: () => seedForgeToken(false),
  },
  "plugin-document": {
    slot: "plugin-document",
    what: "plugin registrations stuck until the window reloads",
    seed: seedPluginDocument,
  },
  "cloud-sync": {
    slot: "cloud-sync",
    what: "an environmental warning whose only action is to silence itself",
    seed: () => {
      useCloudSyncBannerStore.getState().setBanner({ service: "iCloud Drive", projectId: "p1" });
    },
  },
  rosetta: {
    slot: "rosetta",
    what: "the lowest-priority, most static warning in the family",
    seed: () => {
      useRosettaBannerStore.getState().setVisible(true);
    },
  },
} as const satisfies Record<string, BannerFixture>;

export type BannerFixtureName = keyof typeof BANNER_FIXTURES;

/** The ten slots, in coordinator priority order, one canonical fixture each. */
export const SHEET_ROWS: readonly BannerFixtureName[] = [
  "host-crash",
  "watchdog-disabled",
  "host-memory-stall",
  "safe-mode",
  "restore-confirmation",
  "missing-prerequisite",
  "forge-token",
  "plugin-document",
  "cloud-sync",
  "rosetta",
];

function isBannerFixtureName(name: string): name is BannerFixtureName {
  return Object.hasOwn(BANNER_FIXTURES, name);
}

export function requireBannerFixture(name: string): BannerFixture & { name: BannerFixtureName } {
  if (!isBannerFixtureName(name)) {
    throw new Error(
      `Unknown banner fixture "${name}". Known: ${Object.keys(BANNER_FIXTURES).join(", ")}`
    );
  }
  return { name, ...BANNER_FIXTURES[name] };
}
