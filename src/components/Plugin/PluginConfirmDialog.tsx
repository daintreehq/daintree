import { useCallback, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { usePluginConfirmStore, type PluginConfirmationDecision } from "@/store/pluginConfirmStore";

/**
 * Lower-bound read-time gate for destructive dispatches. `resolveOnce` guards
 * the second click; this disables the primary button briefly after each item
 * is promoted so a click meant for the previous modal can't silently approve a
 * freshly-promoted destructive write before the user has read it.
 */
const CONFIRM_COOLDOWN_MS = 1_200;

/** Shared micro-label, matching the section-heading grammar used app-wide. */
const MICRO_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60";

/**
 * Singleton dialog driven by the plugin-action confirmation queue. Mounted
 * once near the top of `App.tsx`, sibling to `McpConfirmDialog`. Reads
 * `current` from `usePluginConfirmStore` and surfaces one `ConfirmDialog`
 * at a time — concurrent dispatches queue FIFO behind the visible modal
 * rather than stacking overlapping dialogs.
 *
 * Unlike the MCP dialog there is no auto-timeout: plugin dispatch has no
 * main-process deadline racing the modal, so it stays open until the user
 * decides (or `usePluginActions` unmounts and drops the request).
 */
export function PluginConfirmDialog() {
  const current = usePluginConfirmStore((state) => state.current);
  const resolveCurrent = usePluginConfirmStore((state) => state.resolveCurrent);
  const resetKey = current?.requestId ?? "null";

  // `resolveCurrent` is synchronous: it resolves the promise and advances the
  // queue so `current` becomes the next item before React re-renders. A rapid
  // double-click would otherwise fire a second `resolveCurrent("approved")`
  // that lands on the freshly-promoted queued item — silently approving an
  // action the user never saw. Gate every resolution on the requestId we've
  // already handled so a given dialog can resolve exactly once.
  const handledRequestIdRef = useRef<string | null>(null);
  const resolveOnce = useCallback(
    (requestId: string, decision: PluginConfirmationDecision) => {
      if (handledRequestIdRef.current === requestId) return;
      handledRequestIdRef.current = requestId;
      resolveCurrent(decision);
    },
    [resolveCurrent]
  );

  if (current === null) {
    return (
      <ErrorBoundary variant="component" componentName="PluginConfirmDialog" resetKeys={[resetKey]}>
        <ConfirmDialog
          isOpen={false}
          title=""
          confirmLabel="Run"
          onConfirm={() => {}}
          variant="destructive"
        />
      </ErrorBoundary>
    );
  }

  const isDestructive = current.effectiveDanger === "confirm";
  const variant = isDestructive ? "destructive" : "default";
  // A no-argument action has nothing to preview, so the whole block is
  // dropped rather than shown holding a placeholder — matching
  // PluginMcpConfirmDialog. The description above already says what runs.
  const hasArgs = current.argsSummary.length > 0;

  return (
    <ErrorBoundary variant="component" componentName="PluginConfirmDialog" resetKeys={[resetKey]}>
      <ConfirmDialog
        isOpen={true}
        onClose={() => resolveOnce(current.requestId, "rejected")}
        title={`Run '${current.actionTitle}'?`}
        description={
          current.actionDescription.trim() ||
          `Action contributed by the '${current.pluginId}' plugin.`
        }
        confirmLabel={current.actionTitle}
        cancelLabel="Cancel"
        onConfirm={() => resolveOnce(current.requestId, "approved")}
        variant={variant}
        // A redacted args block is structured evidence, so this is a dialog
        // rather than an alertdialog. A no-argument action drops the block
        // entirely and really is the brief message alertdialog is for. This
        // tracks whether the payload exists, never whether the disclosure
        // below happens to be open — the role must not flip as the user toggles.
        hasPreview={hasArgs}
        // The queue advances by swapping `current` on a mounted dialog, so the
        // body's scroll offset would otherwise carry into the next request.
        bodyResetKey={current.requestId}
        confirmCooldownMs={isDestructive ? CONFIRM_COOLDOWN_MS : undefined}
        cooldownKey={current.requestId}
      >
        {hasArgs ? (
          // Keyed on the request for the same reason: without this the next
          // promoted action inherits this one's expanded disclosure, showing a
          // payload the user never asked to see for an action they haven't read.
          <ArgumentsDisclosure key={current.requestId} argsSummary={current.argsSummary} />
        ) : null}
      </ConfirmDialog>
    </ErrorBoundary>
  );
}

/**
 * The redacted argument summary, behind a disclosure.
 *
 * Raw payloads shown inline are the classic driver of consent-dialog
 * click-through: they read as noise, and the noise trains people to skip the
 * whole surface. Collapsed, they stay one keystroke away for anyone who wants
 * them without competing with the title and description — which are what this
 * approval actually rests on — for attention. Unlike the plugin-MCP sibling
 * there is no audited content-preview requirement to weigh against that:
 * `docs/architecture/destructive-action-safeguards.md` caps plugin-contributed
 * actions at D1, whose safeguard is the confirm step itself.
 */
function ArgumentsDisclosure({ argsSummary }: { argsSummary: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 text-left",
          "transition-colors duration-150 ease-out hover:bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
        )}
      >
        <ChevronRight
          aria-hidden="true"
          data-animated-chevron
          className={cn(
            "w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <span className={MICRO_LABEL}>Arguments</span>
      </button>
      {expanded && (
        <pre className="mt-1 max-h-40 overflow-y-auto rounded-[var(--radius-md)] bg-overlay-subtle px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap text-daintree-text/80">
          {argsSummary}
        </pre>
      )}
    </div>
  );
}
