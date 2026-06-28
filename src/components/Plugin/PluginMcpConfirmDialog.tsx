import { useCallback, useRef } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginMcpConfirmStore } from "@/store/pluginMcpConfirmStore";
import type { PluginMcpConsentDecision, PluginMcpDangerTier } from "@shared/types/pluginMcpConsent";

const CONFIRM_COOLDOWN_MS = 1_200;

/**
 * Singleton dialog driven by the plugin-MCP consent queue. Mounted once near
 * the top of `App.tsx`, sibling to `PluginConfirmDialog` and `McpConfirmDialog`.
 *
 * Renders the tool description as a plain React text node (never as HTML or
 * Markdown). The description has already been ANSI/OSC-stripped in the main
 * process by `PluginMcpConsentService` — the renderer does no further
 * sanitisation and does not need to: React text-node interpolation escapes
 * by default, and the bytes the renderer holds are the display-safe form.
 *
 * For D2+ tiers, a redacted `argsSummary` (produced by `summarizeMcpArgs` in
 * main) appears below the description in a `<pre>` block; raw call arguments
 * are never sent across IPC.
 */
export function PluginMcpConfirmDialog() {
  const current = usePluginMcpConfirmStore((state) => state.current);
  const resolveCurrent = usePluginMcpConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: PluginMcpConsentDecision) => {
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
        componentName="PluginMcpConfirmDialog"
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

  const isDestructive = current.dangerTier === "D2" || current.dangerTier === "D3";
  const variant = isDestructive ? "destructive" : "default";
  const showArgsPreview =
    current.dangerTier === "D2" || current.dangerTier === "D3" || current.argsSummary.length > 0;

  return (
    <ErrorBoundary
      variant="component"
      componentName="PluginMcpConfirmDialog"
      resetKeys={[resetKey]}
    >
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={titleFor(current.reason, current.toolName)}
        description={`'${current.pluginDisplayName}' wants to run the '${current.toolName}' tool from its MCP server '${current.serverId}'.`}
        confirmLabel="Allow and remember"
        cancelLabel="Reject"
        onConfirm={() => resolveOnce(current.requestId, "approved-and-pin")}
        variant={variant}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            <DangerTierBadge tier={current.dangerTier} />
            {warningLabelFor(current.reason) !== null && (
              <span className="text-status-warning font-medium">
                {warningLabelFor(current.reason)}
              </span>
            )}
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60 mb-1">
              Tool description
            </div>
            <p className="text-sm text-daintree-text/80 whitespace-pre-wrap break-words">
              {current.descriptionDisplay || "(none provided)"}
            </p>
          </div>

          {current.declaredCapabilities.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60 mb-1">
                Plugin capabilities
              </div>
              <ul className="text-xs font-mono text-daintree-text/70 space-y-0.5">
                {current.declaredCapabilities.map((cap) => (
                  <li key={cap}>{cap}</li>
                ))}
              </ul>
            </div>
          )}

          {showArgsPreview && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60 mb-1">
                Arguments
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-overlay-subtle rounded px-2 py-1.5 text-daintree-text/80">
                {current.argsSummary || "(none)"}
              </pre>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </ErrorBoundary>
  );
}

/**
 * Dialog title for a consent reason. Every re-prompt reason (the tool changed
 * since it was pinned, or was revoked) gets a distinct "review and re-approve"
 * framing so a user can tell a rug-pull re-prompt apart from a first-use one —
 * `annotation-changed` in particular must NOT fall through to the generic
 * first-use title, or a server raising a pinned tool's danger tier would be
 * indistinguishable from approving it for the first time. Exported for tests.
 */
export function titleFor(reason: string, toolName: string): string {
  switch (reason) {
    case "raw-changed":
      return `'${toolName}' has changed — review and re-approve?`;
    case "schema-changed":
      return `'${toolName}' inputs changed — review and re-approve?`;
    case "annotation-changed":
      return `'${toolName}' danger level changed — review and re-approve?`;
    case "revoked":
      return `'${toolName}' was previously revoked — allow again?`;
    case "first-use":
    default:
      return `Allow '${toolName}' to run?`;
  }
}

/**
 * Inline warning badge label for a consent reason, or `null` for first-use
 * (no badge — nothing changed). Each re-prompt reason maps to its own label so
 * the badge names what changed. Exported for tests.
 */
export function warningLabelFor(reason: string): string | null {
  switch (reason) {
    case "raw-changed":
      return "Tool description changed";
    case "schema-changed":
      return "Tool inputs changed";
    case "annotation-changed":
      return "Danger level changed";
    case "revoked":
      return "Previously revoked";
    default:
      return null;
  }
}

function DangerTierBadge({ tier }: { tier: PluginMcpDangerTier }) {
  const label = tier === "D0" ? "Read-only" : tier === "D1" ? "Local change" : "Shared state";
  return (
    <span className="px-1.5 py-0.5 rounded bg-overlay-subtle text-daintree-text/70 font-mono">
      {tier} · {label}
    </span>
  );
}
