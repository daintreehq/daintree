import { AlertCircle, AlertTriangle } from "lucide-react";
import type { BuiltInPluginCapability } from "@shared/types/plugin";

/**
 * Per-capability display tier — a renderer-only visual grouping. `danger` is
 * reserved for `shell:exec` (categorically irreversible arbitrary execution);
 * `warning` covers the remaining write/mutation/network capabilities;
 * `neutral` covers read-only and clipboard capabilities. Not the authoritative
 * risk model: the install-time confirm set is `CONFIRM_TRIGGERING_CAPABILITIES`
 * in `shared/config/pluginCapabilities.ts` (e.g. `network:fetch` is warning
 * here but not confirm-triggering there). Colours follow the status tokens,
 * never the accent — risk is not a focus signal (see CLAUDE.md
 * accent-restraint).
 */
export type CapabilitySeverity = "danger" | "warning" | "neutral";

interface CapabilityMeta {
  label: string;
  description: string;
  severity: CapabilitySeverity;
}

/**
 * Human-readable copy and risk tier for every built-in capability. Lives in the
 * renderer (presentation only) — the authoritative danger verdict for the whole
 * plugin is `plugin.pluginDanger`, computed on main. Shared between the detail
 * pane's Permissions tab and the archive-install confirmation dialog so a
 * capability reads identically at install time and after.
 */
export const CAPABILITY_META = {
  "fs:project-read": {
    label: "Read project files",
    description: "View files in the open project",
    severity: "neutral",
  },
  "fs:project-write": {
    label: "Write project files",
    description: "Create, edit, or delete files in the open project",
    severity: "warning",
  },
  "fs:user-data-read": {
    label: "Read app data",
    description: "View Daintree's stored data",
    severity: "neutral",
  },
  "fs:user-data-write": {
    label: "Write app data",
    description: "Modify Daintree's stored data",
    severity: "warning",
  },
  "network:fetch": {
    label: "Make network requests",
    description: "Send and receive data over the network",
    severity: "warning",
  },
  "agent:invoke": {
    label: "Launch agents",
    description: "Start agent sessions on your behalf",
    severity: "warning",
  },
  "agent:read": {
    label: "Read agent activity",
    description: "Observe running agent sessions",
    severity: "neutral",
  },
  "agent:register": {
    label: "Register agent CLIs",
    description: "Add launchable agent commands",
    severity: "warning",
  },
  "agent:input": {
    label: "Send input to agents",
    description: "Type and submit text into running agent sessions",
    severity: "warning",
  },
  "git:read": {
    label: "Read git status",
    description: "View branch and change information",
    severity: "neutral",
  },
  "git:write": {
    label: "Run git commands",
    description: "Commit, branch, and modify git state",
    severity: "warning",
  },
  "clipboard:read": {
    label: "Read clipboard",
    description: "Access clipboard contents",
    severity: "neutral",
  },
  "clipboard:write": {
    label: "Write clipboard",
    description: "Replace clipboard contents",
    severity: "neutral",
  },
  "shell:exec": {
    label: "Run shell commands",
    description: "Execute arbitrary commands on your machine",
    severity: "danger",
  },
} satisfies Record<BuiltInPluginCapability, CapabilityMeta>;

export const SEVERITY_TEXT_CLASS: Record<CapabilitySeverity, string> = {
  danger: "text-status-danger",
  warning: "text-status-warning",
  neutral: "text-daintree-text/40",
};

export function CapabilityRow({
  capability,
  allowedUrls,
}: {
  capability: BuiltInPluginCapability;
  allowedUrls?: string[];
}) {
  const meta = CAPABILITY_META[capability];
  const scoped = capability === "network:fetch" && allowedUrls && allowedUrls.length > 0;
  return (
    <li className="flex items-start gap-2">
      {meta.severity === "danger" ? (
        <AlertCircle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${SEVERITY_TEXT_CLASS.danger}`} />
      ) : meta.severity === "warning" ? (
        <AlertTriangle className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${SEVERITY_TEXT_CLASS.warning}`} />
      ) : (
        <span
          className="w-1.5 h-1.5 rounded-full bg-daintree-text/30 shrink-0 mt-[7px]"
          aria-hidden
        />
      )}
      <div className="min-w-0">
        <div
          className={`text-xs ${meta.severity === "neutral" ? "text-daintree-text/80" : SEVERITY_TEXT_CLASS[meta.severity]}`}
        >
          {meta.label}
        </div>
        <div className="text-[11px] text-daintree-text/40">{meta.description}</div>
        {scoped && (
          <ul className="mt-0.5 space-y-0.5">
            {allowedUrls.map((url) => (
              <li key={url} className="text-[11px] font-mono text-daintree-text/50 break-all">
                {url}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
