import { useCallback, useEffect, useRef } from "react";
import { systemClient } from "@/clients";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { notify } from "@/lib/notify";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";

function isMissing(result: { available: boolean; meetsMinVersion: boolean }): boolean {
  return !result.available || !result.meetsMinVersion;
}

/**
 * Surfaces missing fatal prerequisites (Git, Node) as a global banner. The
 * baseline check already existed but was only reachable from Settings and the
 * Agent Setup wizard, and the wizard is deliberately skipped on first run — so
 * a fresh install learned Git was missing from a raw `spawn git ENOENT` part
 * way into its first clone (#11763).
 *
 * Deliberately off the boot path: the probe spawns subprocesses and
 * `refreshPath()` carries a 10s budget, so it runs after first paint. Main
 * caches the fatal-only result, which is what keeps this to one probe rather
 * than one per open project view.
 */
export function useMissingPrerequisiteWarning(enabled: boolean) {
  const activeRef = useRef(true);
  const inboxedRef = useRef(false);
  const inFlightRef = useRef(false);

  const runCheck = useCallback(async (force: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const result = await systemClient.healthCheck({ fatalOnly: true, force });
      if (!activeRef.current) return;

      const missing = result.prerequisites.filter(isMissing);
      useMissingPrerequisiteStore.getState().setMissing(missing);

      // Inbox entry once per session — the banner is the live surface, but a
      // higher-priority global banner can hold the slot, and the entry is the
      // audit trail that survives that. priority:"low" keeps it inbox-only.
      if (missing.length > 0 && !inboxedRef.current) {
        inboxedRef.current = true;
        const names = missing.map((m) => m.label).join(", ");
        notify({
          type: "warning",
          priority: "low",
          title: "Missing required tools",
          message: `${names} ${missing.length === 1 ? "is" : "are"} not installed or not on PATH. Git operations and agent launches will fail until ${missing.length === 1 ? "it's" : "they're"} available.`,
          supersedeKey: "missing-prerequisites",
          countable: false,
          context: { eventKind: "host" },
        });
      }
    } catch (err) {
      // A failed probe must not invent a missing prerequisite — leave the last
      // known state alone and stay quiet; the next focus re-check retries.
      logWarn("Prerequisite health check failed", {
        error: formatErrorMessage(err, "Health check failed"),
      });
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void runCheck(false);
  }, [enabled, runCheck]);

  // Re-check when the user comes back to Daintree, so installing Git while
  // Daintree is running clears the banner without a restart. refreshPath()
  // re-reads the registry Path on Windows and the fallback paths already cover
  // the standard Git install locations, so a mid-session install is visible.
  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    const handleFocus = () => {
      // document.hasFocus() is stale when read synchronously inside the focus
      // handler on Chromium 148 (#10230), so the read is deferred a frame. The
      // guard keeps a project-view switch inside the same window from forcing a
      // re-probe; main's in-flight dedup covers whatever slips through.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!document.hasFocus()) return;
        void runCheck(true);
      });
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, runCheck]);

  return runCheck;
}
