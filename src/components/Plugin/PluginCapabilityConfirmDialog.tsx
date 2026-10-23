import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginCapabilityConfirmStore } from "@/store/pluginCapabilityConfirmStore";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import {
  EXTERNAL_LINK_CONSENT,
  PLUGIN_PANEL_ATTENTION_GRANT,
  type PluginCapabilityConsentDecision,
  type PluginRestorableGrant,
} from "@shared/types/pluginCapabilityConsent";
import type { BuiltInPluginCapability } from "@shared/types/plugin";
import { cn } from "@/lib/utils";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { useHostConnection } from "@/hooks/useHostConnection";

/**
 * Singleton dialog driven by the just-in-time capability consent queue (#10524).
 * Mounted once near the top of `App.tsx`, sibling to `PluginMcpConfirmDialog`.
 *
 * Surfaces the first time a plugin exercises a high-risk host capability
 * (`shell:exec`, `fs:*-write`, `git:write`). "Allow and remember" grants the
 * capability for the plugin's lifetime; closing/rejecting denies this call.
 */
export function PluginCapabilityConfirmDialog() {
  const current = usePluginCapabilityConfirmStore((state) => state.current);
  const resolveCurrent = usePluginCapabilityConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";
  // A window attached to another machine asks on that host's behalf: the
  // capability is used there, so the question names it.
  const { hostId, hostName } = useHostConnection();
  const hostLabel = hostId === null ? null : (hostName ?? hostId);
  const onHost = hostLabel === null ? "" : ` on ${hostLabel}`;

  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: PluginCapabilityConsentDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  if (current === null) {
    return (
      <ErrorBoundary
        variant="component"
        componentName="PluginCapabilityConfirmDialog"
        resetKeys={[resetKey]}
      >
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Allow"
          onConfirm={() => {}}
          variant="default"
        />
      </ErrorBoundary>
    );
  }

  if (current.restore !== undefined) {
    return (
      <ErrorBoundary
        variant="component"
        componentName="PluginCapabilityConfirmDialog"
        resetKeys={[resetKey]}
      >
        <ConfirmDialog
          isOpen={true}
          onClose={() => resolveOnce(current.requestId, "rejected")}
          title={restoreTitleFor(current.pluginDisplayName)}
          description={`'${current.pluginDisplayName}' was replaced with a different version, so the permissions you gave the previous version were turned off. Restoring gives this version the same access again. Anything else it asks for is asked separately.`}
          confirmLabel="Restore permissions"
          cancelLabel="Leave off"
          onConfirm={() => resolveOnce(current.requestId, "approved-and-pin")}
          variant="destructive"
          // The body carries a permission list, so this is a `dialog`, not an `alertdialog`.
          hasPreview={true}
          hint={
            <span className="min-w-0 leading-tight">Only what this version still declares</span>
          }
        >
          <div>
            <div className={cn(SECTION_LABEL_CLASS, "mb-1")}>Permissions</div>
            <ul className="space-y-1.5">
              {current.restore.map((grant) => (
                <RestoreRow key={grant} grant={grant} />
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      </ErrorBoundary>
    );
  }

  if (current.site !== undefined || current.capability === EXTERNAL_LINK_CONSENT) {
    const site = current.site ?? "";
    return (
      <ErrorBoundary
        variant="component"
        componentName="PluginCapabilityConfirmDialog"
        resetKeys={[resetKey]}
      >
        <ConfirmDialog
          isOpen={true}
          onClose={() => resolveOnce(current.requestId, "rejected")}
          title={externalLinkTitleFor(current.pluginDisplayName, site)}
          description={`'${current.pluginDisplayName}' is asking to open links to ${site} in your browser${onHost} for the first time. Allowing remembers this site for the plugin until you uninstall or replace the plugin.`}
          confirmLabel="Allow and remember"
          cancelLabel="Deny"
          onConfirm={() => resolveOnce(current.requestId, "approved-and-pin")}
          variant="default"
          hint={<span className="min-w-0 leading-tight">Only {site}, not other sites</span>}
        />
      </ErrorBoundary>
    );
  }

  // A host's plugin reaching this computer's clipboard is the one question
  // about this machine rather than the host, so the host names the plugin.
  const forThisComputer = hostLabel !== null && reachesThisComputer(current.capability);

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginCapabilityConfirmDialog"
      resetKeys={[resetKey]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={titleFor(
          current.pluginDisplayName,
          current.capability,
          forThisComputer ? hostLabel : null
        )}
        description={
          forThisComputer
            ? `A plugin running on ${hostLabel} is asking to ${capabilityAction(current.capability)}. Your answer is remembered on this computer for this plugin on ${hostLabel}.`
            : `'${current.pluginDisplayName}' is asking to ${capabilityAction(current.capability)}${onHost} for the first time. Allowing remembers this for the plugin until you uninstall or revoke it.`
        }
        confirmLabel="Allow and remember"
        cancelLabel="Deny"
        onConfirm={() => resolveOnce(current.requestId, "approved-and-pin")}
        variant="destructive"
        // The body carries a capability list, so this is a `dialog` — APG
        // reserves `alertdialog` for a brief message read out whole.
        hasPreview={true}
        // Beside the action, where a modal is actually read: title, then
        // primary button. The description still carries the full wording for
        // the accessible description; this is the visual scan path.
        hint={
          <span className="min-w-0 leading-tight">
            {forThisComputer
              ? "Remembered on this computer"
              : "Remembered until you uninstall or revoke the plugin"}
          </span>
        }
      >
        <div className="space-y-3">
          <div>
            <div className={cn(SECTION_LABEL_CLASS, "mb-1")}>Capability</div>
            <ul>
              <CapabilityRow capability={current.capability} />
            </ul>
          </div>

          {current.declaredCapabilities.length > 0 && (
            <div>
              <div className={cn(SECTION_LABEL_CLASS, "mb-1")}>All declared capabilities</div>
              <ul className="space-y-1.5">
                {current.declaredCapabilities.map((cap) => (
                  <CapabilityRow key={cap} capability={cap} />
                ))}
              </ul>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}

/** One permission offered back. "Show in attention views" has no capability token, so no capability row. */
function RestoreRow({ grant }: { grant: PluginRestorableGrant }) {
  if (grant !== PLUGIN_PANEL_ATTENTION_GRANT) return <CapabilityRow capability={grant} />;
  return (
    <li className="flex items-start gap-2">
      <span className="w-1.5 h-1.5 rounded-full bg-text-primary/30 shrink-0 mt-[7px]" aria-hidden />
      <div className="min-w-0">
        <div className="text-xs text-text-primary">Show in attention views</div>
        <div className="text-2xs text-text-secondary">
          Its panels&apos; activity appears in Pilot and the attention filters
        </div>
      </div>
    </li>
  );
}

/** Title of the offer-back after a replacing install. Exported for tests. */
export function restoreTitleFor(pluginDisplayName: string): string {
  return `Restore permissions for '${pluginDisplayName}'?`;
}

/** Title of the per-site link prompt; the hostname is shown as text, never as a link. Exported for tests. */
export function externalLinkTitleFor(pluginDisplayName: string, site: string): string {
  return `Allow '${pluginDisplayName}' to open links to ${site}?`;
}

/** Dialog title — sentence case, no trailing period (UI microcopy rules). Exported for tests. */
export function titleFor(
  pluginDisplayName: string,
  capability: BuiltInPluginCapability,
  onHost: string | null = null
): string {
  const who = onHost === null ? `'${pluginDisplayName}'` : `'${pluginDisplayName}' on ${onHost}`;
  return `Allow ${who} to ${capabilityAction(capability)}?`;
}

/** Capabilities a host's plugin asks of this computer rather than the host. Exported for tests. */
export function reachesThisComputer(capability: BuiltInPluginCapability): boolean {
  return capability === "clipboard:read" || capability === "clipboard:write";
}

/** Short verb phrase for the title/description. Exported for tests. */
export function capabilityAction(capability: BuiltInPluginCapability): string {
  switch (capability) {
    case "clipboard:read":
      return "read this computer's clipboard";
    case "clipboard:write":
      return "write to this computer's clipboard";
    case "shell:exec":
      return "run commands";
    case "fs:project-write":
      return "write files in your project";
    case "fs:user-data-write":
      return "write to its data folder";
    case "git:write":
      return "make git changes";
    case "terminal:read":
      return "read what your terminals show";
    default:
      return `use the '${capability}' capability`;
  }
}
