import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import type { PrerequisiteCheckResult } from "@shared/types";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { detectOS, isBlockExecutable } from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Install runs well past the Doherty threshold, so the status line switches to
 *  a reassurance once it has been going this long. */
const STILL_WORKING_MS = 5_000;

interface InstallCandidate {
  result: PrerequisiteCheckResult;
  block: AgentInstallBlock;
  methodIndex: number;
  /** Binary the command drives (`brew`, `winget`) — probed before offering it. */
  packageManager: string;
}

/**
 * Picks the block to offer for a missing prerequisite on this OS. macOS gets a
 * second block for the Command Line Tools case, which is a different shape:
 * `xcode-select --install` hands off to Apple's GUI installer, so it's chosen
 * only when the probe says the tools are what's missing.
 */
function pickInstallCandidate(result: PrerequisiteCheckResult): InstallCandidate | null {
  const blocks = result.installBlocks?.[detectOS()] ?? result.installBlocks?.generic;
  if (!blocks || blocks.length === 0) return null;

  const wantsCommandLineTools = result.unavailableReason === "macos-command-line-tools-missing";
  const methodIndex = blocks.findIndex((b) =>
    wantsCommandLineTools ? b.opensExternalInstaller === true : b.opensExternalInstaller !== true
  );
  if (methodIndex === -1) return null;

  const block = blocks[methodIndex];
  if (!block || !isBlockExecutable(block)) return null;

  const packageManager = block.commands?.[0]?.trim().split(/\s+/)[0];
  if (!packageManager) return null;

  return { result, block, methodIndex, packageManager };
}

function describe(missing: PrerequisiteCheckResult[]): string {
  const names = missing.map((m) => m.label).join(", ");
  const isOne = missing.length === 1;
  return `${names} ${isOne ? "is" : "are"} not installed or not on PATH, so git operations and agent launches will fail until ${isOne ? "it's" : "they're"} available.`;
}

export function MissingPrerequisiteBanner() {
  const missing = useMissingPrerequisiteStore((s) => s.missing);
  const dismiss = useMissingPrerequisiteStore((s) => s.dismiss);
  const install = useMissingPrerequisiteStore((s) => s.install);
  const setInstall = useMissingPrerequisiteStore((s) => s.setInstall);

  const [packageManagerReady, setPackageManagerReady] = useState(false);
  const [stillWorking, setStillWorking] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const candidate = useMemo(() => {
    for (const result of missing) {
      const found = pickInstallCandidate(result);
      if (found) return found;
    }
    return null;
  }, [missing]);

  // Don't offer a button that can only ENOENT — winget is absent on plenty of
  // Windows images and Homebrew is not a given on macOS.
  useEffect(() => {
    if (!candidate) {
      setPackageManagerReady(false);
      return;
    }
    let active = true;
    void systemClient
      .checkCommand(candidate.packageManager)
      .then((present) => {
        if (active) setPackageManagerReady(present);
      })
      .catch(() => {
        if (active) setPackageManagerReady(false);
      });
    return () => {
      active = false;
    };
  }, [candidate]);

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
    if (!candidate) return;
    const { result, block, methodIndex } = candidate;
    const jobId = crypto.randomUUID();
    const errorLog: string[] = [];

    setInstall({ tool: result.tool, status: "running", statusLine: "", error: null });

    const cleanup = window.electron.system.onAgentInstallProgress((event) => {
      if (event.jobId !== jobId) return;
      if (event.stream === "stderr") errorLog.push(event.chunk);
      const line = event.chunk.trim().split("\n").filter(Boolean).pop();
      if (!line) return;
      const current = useMissingPrerequisiteStore.getState().install;
      if (current?.status !== "running") return;
      useMissingPrerequisiteStore.getState().setInstall({ ...current, statusLine: line });
    });

    try {
      const outcome = await window.electron.system.installAgent({
        prerequisiteTool: result.tool,
        methodIndex,
        jobId,
      });

      if (!outcome.success) {
        setInstall({
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
        setInstall({ tool: result.tool, status: "handed-off", statusLine: "", error: null });
        return;
      }

      // Success is what a fresh probe says, not what the exit code claims.
      const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
      const stillMissing = health.prerequisites.filter((p) => !p.available || !p.meetsMinVersion);
      useMissingPrerequisiteStore.getState().setMissing(stillMissing);

      if (stillMissing.some((p) => p.tool === result.tool)) {
        setInstall({
          tool: result.tool,
          status: "error",
          statusLine: "",
          error: `${result.label} still isn't on PATH after the install finished`,
        });
        return;
      }

      setInstall(null);
      notify({
        type: "success",
        title: `${result.label} installed`,
        message: `${result.label} is now available. Git operations and agent launches will work.`,
      });
    } catch (err) {
      logError("Prerequisite install failed", err);
      setInstall({
        tool: result.tool,
        status: "error",
        statusLine: "",
        error: formatErrorMessage(err, "Install failed"),
      });
    } finally {
      cleanup();
    }
  }, [candidate, setInstall]);

  const recheck = useCallback(async () => {
    try {
      const health = await systemClient.healthCheck({ fatalOnly: true, force: true });
      useMissingPrerequisiteStore
        .getState()
        .setMissing(health.prerequisites.filter((p) => !p.available || !p.meetsMinVersion));
      setInstall(null);
    } catch (err) {
      logError("Prerequisite re-check failed", err);
    }
  }, [setInstall]);

  if (missing.length === 0) return null;

  const canInstall = candidate !== null && packageManagerReady;
  const command = candidate?.block.commands?.join(" && ");
  const handedOff = install?.status === "handed-off";

  const description = handedOff
    ? "Finish the macOS installer, then re-check."
    : install?.status === "error"
      ? install.error
      : describe(missing);

  const contextLine = isRunning
    ? stillWorking
      ? install.statusLine || "Still working…"
      : install.statusLine || "Installing…"
    : command;

  const action =
    canInstall && !handedOff
      ? {
          id: "install",
          label: candidate.block.opensExternalInstaller
            ? "Open installer"
            : `Install ${candidate.result.label}`,
          variant: "primary" as const,
          loading: isRunning,
          disabled: isRunning,
          onClick: () => void runInstall(),
        }
      : {
          id: "recheck",
          label: "Re-check",
          variant: "primary" as const,
          onClick: () => void recheck(),
        };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={
        missing.length === 1 && missing[0]
          ? `${missing[0].label} is missing`
          : "Required tools are missing"
      }
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
