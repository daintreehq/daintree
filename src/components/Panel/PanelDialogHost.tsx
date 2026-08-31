import { useCallback, useEffect, useSyncExternalStore } from "react";
import { PanelTop } from "lucide-react";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import {
  getPanelKindDefinitionsSnapshot,
  subscribeToPanelKindDefinitions,
} from "@/panels/registry";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Presents panels as modal dialogs — the third presentation alongside
 * `GridPanel` and `DockedPanel`.
 *
 * Each panel is a normal registry record at `location: "dialog"`, so its kind's
 * component renders here unmodified rather than being duplicated as a bespoke
 * modal. `AppDialog` owns the surface, focus trap, Escape handling, and focus
 * restore; `ContentPanel` suppresses its own header for this location so the
 * title and close control aren't drawn twice.
 *
 * Every entry in the stack stays mounted, not just the top one: a dialog panel
 * can open another (the review hub drills into a per-file diff), and unmounting
 * the parent to show the child would discard all of the parent's local state
 * (#11243). Only the topmost frame is focused.
 *
 * Lifecycle is owned by the store, not by this component's effects: React 19
 * StrictMode double-invokes effects in dev, which would destroy and recreate
 * the panel record on mount.
 */
export function PanelDialogHost() {
  const dialogStack = usePanelDialogStore((state) => state.dialogStack);

  if (dialogStack.length === 0) return null;

  return (
    <>
      {dialogStack.map((panelId, index) => (
        <PanelDialogFrame
          key={panelId}
          panelId={panelId}
          // The base frame keeps the standard modal layer; anything layered on
          // top needs the nested tier or it would paint under its own parent.
          isNested={index > 0}
          isTop={index === dialogStack.length - 1}
        />
      ))}
    </>
  );
}

function PanelDialogFrame({
  panelId,
  isNested,
  isTop,
}: {
  panelId: string;
  isNested: boolean;
  isTop: boolean;
}) {
  const requestSeq = usePanelDialogStore((state) => state.requestSeq);
  const closePanelDialogById = usePanelDialogStore((state) => state.closePanelDialogById);
  const promoteToGrid = usePanelDialogStore((state) => state.promoteToGrid);
  const reconcileRemovedPanel = usePanelDialogStore((state) => state.reconcileRemovedPanel);

  // Keyed read, not a subscription to the whole `panelsById` map: that map
  // churns on every panel update and would re-render the dialog with it.
  const panel = usePanelStore(useCallback((state) => state.panelsById[panelId], [panelId]));

  const handleClose = useCallback(
    () => closePanelDialogById(panelId),
    [closePanelDialogById, panelId]
  );

  const handlePromote = useCallback(() => {
    // A refused promotion (panel limit reached) leaves the dialog open and
    // surfaces its own notification from the store action.
    promoteToGrid();
  }, [promoteToGrid]);

  // Reconcile a pointer whose record was removed elsewhere (worktree teardown,
  // a bulk action). This only clears a dangling id — it never creates or
  // destroys the panel, so StrictMode's double invoke is harmless.
  useEffect(() => {
    if (!panel) reconcileRemovedPanel(panelId);
  }, [panelId, panel, reconcileRemovedPanel]);

  // Above the early returns below — hooks cannot be conditional. Subscribing
  // here is what lets a dialog whose plugin kind registers late resolve to its
  // real component instead of staying blank forever (#11636); the lookup reads
  // this snapshot rather than calling `getPanelKindDefinition` separately,
  // which React Compiler would cache keyed only on the kind.
  const definitions = useSyncExternalStore(
    subscribeToPanelKindDefinitions,
    getPanelKindDefinitionsSnapshot
  );

  if (!panel) return null;

  const definition = definitions[panel.kind ?? "terminal"];
  if (!definition) return null;

  const PanelComponent = definition.component;

  return (
    <AppDialog
      isOpen={true}
      onClose={handleClose}
      size="6xl"
      maxHeight="max-h-[85vh]"
      // Full-height kinds pin the surface at the max rather than sizing to
      // content, so the dialog doesn't grow and shrink as the tree loads.
      {...(definition.dialogFullHeight ? { className: "h-[85vh]" } : {})}
      zIndex={isNested ? "nested" : "modal"}
      data-testid="panel-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>{panel.title}</AppDialog.Title>
        <div className="flex items-center gap-1">
          {/* Promotion always targets the topmost dialog, so it is only offered
              there — a suspended parent's button would move the wrong panel. */}
          {isTop && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePromote}
              data-testid="panel-dialog-open-as-panel"
            >
              <PanelTop className="h-3.5 w-3.5" />
              Open as panel
            </Button>
          )}
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>
      {/* A plain element, not `AppDialog.Body`/`BodyScroll`: a hosted panel
          fills the dialog edge to edge and wants none of the dialog column.
          Both body variants reserve a scrollbar gutter, and `scrollbar-gutter`
          reserves its space on an `overflow: hidden` box too — so cancelling
          their padding would still leave the reservation behind as dead inset
          down both sides of the panel. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ErrorBoundary
          variant="component"
          componentName={`PanelDialog:${panel.kind ?? "terminal"}`}
          resetKeys={[requestSeq]}
        >
          <PanelComponent
            id={panelId}
            title={panel.title}
            worktreeId={panel.worktreeId}
            isFocused={isTop}
            location="dialog"
            onFocus={noop}
            onClose={handleClose}
          />
        </ErrorBoundary>
      </div>
    </AppDialog>
  );
}

// Focus inside a dialog is owned by AppDialog's trap; the panel's grid focus
// pointer must not move, so `onFocus` is intentionally inert here.
function noop() {}
