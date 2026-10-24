import { useEffect, useState } from "react";
import * as semver from "semver";
import { logError } from "@/utils/logger";
import { getAgentConfig } from "@/config/agents";

export function useAssistantVersionWarning(preferredAgentId: string | null) {
  // Version gate at the configuration point: the launch path already blocks an
  // outdated CLI (HelpPanelVersionGate), but the user can pick a too-old agent
  // here with no warning. Probe the selected agent's version (12h cached in
  // AgentVersionService, so cheap) and surface a non-blocking hint inline.
  const [versionWarning, setVersionWarning] = useState<{
    agentName: string;
    installed: string;
    required: string;
  } | null>(null);

  // Isolated version-probe effect (kept separate from the settings-init effect
  // per past lesson #4958). Mirrors HelpSessionController.probeAssistantVersion:
  // any non-definitive result (no minimum configured, no installed version, or
  // a comparison error) clears the warning so we never block on a transient
  // failure or show a stale hint after switching agents.
  useEffect(() => {
    let cancelled = false;
    if (!preferredAgentId) {
      setVersionWarning(null);
      return;
    }
    const config = getAgentConfig(preferredAgentId);
    const required = config?.assistantMinVersion;
    if (!required) {
      setVersionWarning(null);
      return;
    }
    const agentName = config?.name ?? preferredAgentId;
    // Drop any prior agent's warning up front so the banner never shows a stale
    // name/version while this probe is in flight.
    setVersionWarning(null);
    window.electron.system
      .getAgentVersion(preferredAgentId)
      .then((info) => {
        if (cancelled) return;
        const installed = info?.installedVersion;
        if (!installed) {
          setVersionWarning(null);
          return;
        }
        try {
          setVersionWarning(
            semver.lt(installed, required) ? { agentName, installed, required } : null
          );
        } catch (err) {
          setVersionWarning(null);
          logError("Failed to compare assistant CLI version in settings", err);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setVersionWarning(null);
        logError("Failed to probe assistant CLI version in settings", err);
      });
    return () => {
      cancelled = true;
    };
  }, [preferredAgentId]);

  return versionWarning;
}
