import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginCapabilityConfirmStore } from "@/store/pluginCapabilityConfirmStore";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import type { PluginCapabilityConsentDecision } from "@shared/types/pluginCapabilityConsent";
import type { BuiltInPluginCapability } from "@shared/types/plugin";

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

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginCapabilityConfirmDialog"
      resetKeys={[resetKey]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={titleFor(current.pluginDisplayName, current.capability)}
        description={`'${current.pluginDisplayName}' is asking to ${capabilityAction(current.capability)} for the first time. Allowing remembers this for the plugin until you uninstall or revoke it.`}
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
            Remembered until you uninstall or revoke the plugin
          </span>
        }
      >
        <div className="space-y-3">
          <div>
            <div className="text-2xs font-semibold uppercase tracking-wider text-daintree-text/60 mb-1">
              Capability
            </div>
            <ul>
              <CapabilityRow capability={current.capability} />
            </ul>
          </div>

          {current.declaredCapabilities.length > 0 && (
            <div>
              <div className="text-2xs font-semibold uppercase tracking-wider text-daintree-text/60 mb-1">
                All declared capabilities
              </div>
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

/** Dialog title — sentence case, no trailing period (UI microcopy rules). Exported for tests. */
export function titleFor(pluginDisplayName: string, capability: BuiltInPluginCapability): string {
  return `Allow '${pluginDisplayName}' to ${capabilityAction(capability)}?`;
}

/** Short verb phrase for the title/description. Exported for tests. */
export function capabilityAction(capability: BuiltInPluginCapability): string {
  switch (capability) {
    case "shell:exec":
      return "run commands";
    case "fs:project-write":
      return "write files in your project";
    case "fs:user-data-write":
      return "write to its data folder";
    case "git:write":
      return "make git changes";
    default:
      return `use the '${capability}' capability`;
  }
}
