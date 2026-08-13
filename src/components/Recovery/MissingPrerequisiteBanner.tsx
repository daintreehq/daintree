import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import type { PrerequisiteCheckResult } from "@shared/types";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { detectOS, isBlockExecutable } from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** The install runs well past the Doherty threshold, so the status line swaps
 *  to a reassurance once it has been going this long. A wait threshold rather
 *  than a motion duration, so it lives with the component. */
const STILL_WORKING_MS = 5_000;

/** What to show for the first missing prerequisite we can say something about.
 *  `block` is the instructions to display; `autoInstall` is the strictly
 *  narrower question of whether we may run them ourselves. */
interface Guidance {
  result: PrerequisiteCheckResult;
  block: AgentInstallBlock | null;
  methodIndex: number;
  /** Binary the command drives (`brew`, `winget`) — probed before offering it. */
  packageManager: string | null;
  autoInstallable: boolean;
}

/**
 * Picks the block to show for a missing prerequisite on this OS. macOS carries
 * a second block for the Command Line Tools case, which is a different shape:
 * `xcode-select --install` hands off to Apple's GUI installer, so it's chosen
 * only when the probe says the tools are what's missing.
 */
function pickGuidance(result: PrerequisiteCheckResult): Guidance | null {
  const blocks = result.installBlocks?.[detectOS()] ?? result.installBlocks?.generic;
  if (!blocks || blocks.length === 0) {
    return { result, block: null, methodIndex: 0, packageManager: null, autoInstallable: false };
  }

  const wantsCommandLineTools = result.unavailableReason === "macos-command-line-tools-missing";
  const preferred = blocks.findIndex((b) =>
    wantsCommandLineTools ? b.opensExternalInstaller === true : b.opensExternalInstaller !== true
  );
  const methodIndex = preferred === -1 ? 0 : preferred;
  const block = blocks[methodIndex] ?? null;
  if (!block) {
    return { result, block: null, methodIndex: 0, packageManager: null, autoInstallable: false };
  }

  // A block we can't safely run — a sudo or pipe-to-shell command — is still
  // worth showing: the user can copy it. It just isn't a one-click candidate.
  const packageManager = block.commands?.[0]?.trim().split(/\s+/)[0] ?? null;
  return {
    result,
    block,
    methodIndex,
    packageManager,
    autoInstallable: isBlockExecutable(block) && packageManager !== null,
  };
}

function describe(missing: PrerequisiteCheckResult[]): string {
  const names = missing.map((m) => m.label).join(", ");
  const isOne = missing.length === 1;
  const subject = isOne ? "it's" : "they're";
  const outdated = missing.every((m) => m.available);
  const problem = outdated
    ? `${names} ${isOne ? "is" : "are"} below the version Daintree needs`
    : `${names} ${isOne ? "is" : "are"} not installed or not on PATH`;
  return `${problem}, so git operations and agent launches will fail until ${subject} sorted.`;
}

function title(missing: PrerequisiteCheckResult[]): string {
  const only = missing.length === 1 ? missing[0] : undefined;
  if (!only) return "Required tools are missing";
  return only.available ? `${only.label} is out of date` : `${only.label} is missing`;
}

export function MissingPrerequisiteBanner() {
  const missing = useMissingPrerequisiteStore((s) => s.missing);
  const dismiss = useMissingPrerequisiteStore((s) => s.dismiss);
  const install = useMissingPrerequisiteStore((s) => s.install);
  const setInstall = useMissingPrerequisiteStore((s) => s.setInstall);

  const [packageManagerReady, setPackageManagerReady] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);

  const guidance = useMemo(() => {
    for (const result of missing) {
      const found = pickGuidance(result);
      if (found) return found;
    }
    return null;
  }, [missing]);

  // Don't offer a button that can only ENOENT — winget is absent on plenty of
  // Windows images and Homebrew is not a given on macOS.
  const packageManager = guidance?.autoInstallable ? guidance.packageManager : null;
  useEffect(() => {
    setPackageManagerReady(false);
    if (!packageManager) return;
    let active = true;
    void systemClient
      .checkCommand(packageManager)
      .then((present) => {
        if (active) setPackageManagerReady(present);
      })
      .catch(() => {
        if (active) setPackageManagerReady(false);
      });
    return () => {
      active = false;
    };
  }, [packageManager]);

  const isRunning = install?.status === "running";

  useEffect(() => {
    if (!isRunning) {
      setStillWorking(false);
      return;
    }
    const timer = setTimeout(() => setStillWorking(true), STILL_WORKING_MS);
    return () => clearTimeout(timer);
  }, [isRunning]);

  const runInstall = useCallback(async () => {
    if (!guidance?.block || !guidance.autoInstallable) return;
    // The store is the source of truth for whether a job is live: this
    // component unmounts whenever a higher-priority global banner takes the
    // slot, so a remount must not be able to start a second install.
    if (useMissingPrerequisiteStore.getState().install?.status === "running") return;

    const { result, block, methodIndex } = guidance;
    const jobId = crypto.randomUUID();
    const errorLog: string[] = [];

    setInstall({ jobId, tool: result.tool, status: "running", statusLine: "", error: null });

    const cleanup = window.electron.system.onAgentInstallProgress((event) => {
      if (event.jobId !== jobId) return;
      if (event.stream === "stderr") errorLog.push(event.chunk);
      const line = event.chunk.trim().split("\n").filter(Boolean).pop();
      if (!line) return;
      const current = useMissingPrerequisiteStore.getState().install;
      // A superseded job's output must not overwrite the live one's status.
      if (current?.jobId !== jobId || current.status !== "running") return;
      useMissingPrerequisiteStore.getState().setInstall({ ...current, statusLine: line });
    });

    /** Writes only if this job still owns the slot. */
    const settle = (job: Parameters<typeof setInstall>[0]) => {
      if (useMissingPrerequisiteStore.getState().install?.jobId !== jobId) return;
      setInstall(job);
    };

    try {
      const outcome = await window.electron.system.installAgent({
        prerequisiteTool: result.tool,
        methodIndex,
        jobId,
      });

      if (!outcome.success) {
        settle({
          jobId,
          tool: result.tool,
          status: "error",
          statusLine: "",
          error: errorLog.join("").trim() || outcome.error || "Install failed",
        });
        return;
      }

      // A block that hands off to an external installer returns before that
      // installer has done anything, so a zero exit says nothing about whether
      // the tool is there. Ask the user to finish and re-check instead.
      if (block.opensExternalInstaller) {
        settle({ jobId, tool: result.tool, status: "handed-off", statusLine: "", error: null });
        return;
      }

      // Success is what a fresh probe says, not what the exit code claims.
      const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
      const stillMissing = health.prerequisites.filter((p) => !p.available || !p.meetsMinVersion);
      useMissingPrerequisiteStore.getState().setMissing(stillMissing);

      if (stillMissing.some((p) => p.tool === result.tool)) {
        settle({
          jobId,
          tool: result.tool,
          status: "error",
          statusLine: "",
          error: `${result.label} isn't usable yet — the install finished but the check still fails`,
        });
        return;
      }

      settle(null);
      // The banner is gone for this tool, so the toast is the only close-loop
      // signal. It speaks for the tool it installed and nothing more — other
      // prerequisites may still be outstanding.
      notify({
        type: "success",
        title: `${result.label} installed`,
        message:
          stillMissing.length > 0
            ? `Still missing: ${stillMissing.map((p) => p.label).join(", ")}.`
            : `Daintree found ${result.label} on PATH.`,
      });
    } catch (err) {
      logError("Prerequisite install failed", err);
      settle({
        jobId,
        tool: result.tool,
        status: "error",
        statusLine: "",
        error: formatErrorMessage(err, "Install failed"),
      });
    } finally {
      cleanup();
    }
  }, [guidance, setInstall]);

  const recheck = useCallback(async () => {
    // Never wipe a live job's state from under it.
    if (useMissingPrerequisiteStore.getState().install?.status === "running") return;
    setIsRechecking(true);
    try {
      const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
      useMissingPrerequisiteStore
        .getState()
        .setMissing(health.prerequisites.filter((p) => !p.available || !p.meetsMinVersion));
      setInstall(null);
    } catch (err) {
      logError("Prerequisite re-check failed", err);
      setInstall({
        jobId: "recheck",
        tool: guidance?.result.tool ?? "",
        status: "error",
        statusLine: "",
        error: formatErrorMessage(err, "Couldn't check for the tool"),
      });
    } finally {
      setIsRechecking(false);
    }
  }, [guidance, setInstall]);

  const openInstallUrl = useCallback(() => {
    if (!guidance?.result.installUrl) return;
    void actionService.dispatch(
      "system.openExternal",
      { url: guidance.result.installUrl },
      { source: "user" }
    );
  }, [guidance]);

  if (missing.length === 0) return null;

  const failed = install?.status === "error";
  const handedOff = install?.status === "handed-off";
  const canInstall = guidance?.autoInstallable === true && packageManagerReady;
  const command = guidance?.block?.commands?.join(" && ");

  const description = handedOff
    ? "Finish the macOS installer, then re-check"
    : failed
      ? install.error
      : describe(missing);

  const contextLine = isRunning
    ? install.statusLine || (stillWorking ? "Still working…" : "Installing…")
    : command;

  // `isRunning` is read from the store, not local state, so a remount mid-job
  // still renders the disabled installing action rather than an enabled one.
  const action =
    canInstall && !handedOff
      ? {
          id: "install",
          label: guidance?.block?.opensExternalInstaller
            ? "Open installer"
            : `Install ${guidance?.result.label}`,
          variant: "primary" as const,
          loading: isRunning,
          disabled: isRunning,
          onClick: () => void runInstall(),
        }
      : guidance?.block || !guidance?.result.installUrl
        ? {
            id: "recheck",
            label: "Re-check",
            variant: "primary" as const,
            loading: isRechecking,
            disabled: isRunning || isRechecking,
            onClick: () => void recheck(),
          }
        : {
            id: "install-docs",
            label: "View install guide",
            variant: "primary" as const,
            onClick: openInstallUrl,
          };

  // A failed install is an error the user has to act on; everything else here
  // is an advisory about the environment.
  if (failed) {
    return (
      <InlineStatusBanner
        icon={AlertTriangle}
        title={`Couldn't install ${install.tool || "the tool"}`}
        description={description}
        contextLine={command}
        severity="error"
        role="alert"
        onClose={dismiss}
        closeAriaLabel="Dismiss missing tool warning"
        action={{
          id: "retry",
          label: "Retry",
          variant: "primary",
          onClick: () => void (canInstall ? runInstall() : recheck()),
        }}
      />
    );
  }

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={title(missing)}
      description={description}
      contextLine={contextLine}
      severity="warning"
      role="status"
      onClose={dismiss}
      closeAriaLabel="Dismiss missing tool warning"
      actions={[action]}
    />
  );
}
