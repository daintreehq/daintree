import { useCallback } from "react";
import { PanelTop } from "lucide-react";
import { usePanelStore } from "@/store/panelStore";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { getPanelKindDefinition } from "@/panels/registry";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * Presents a panel as a modal dialog — the third presentation alongside
 * `GridPanel` and `DockedPanel`.
 *
 * The panel is a normal registry record at `location: "dialog"`, so its kind's
 * component renders here unmodified rather than being duplicated as a bespoke
 * modal. `AppDialog` owns the surface, focus trap, Escape handling, and focus
 * restore; `ContentPanel` suppresses its own header for this location so the
 * title and close control aren't drawn twice.
 *
 * Lifecycle is owned by the store, not by this component's effects: React 19
 * StrictMode double-invokes effects in dev, which would destroy and recreate
 * the panel record on mount.
 */
export function PanelDialogHost() {
  const panelId = usePanelDialogStore((state) => state.panelId);
  const requestSeq = usePanelDialogStore((state) => state.requestSeq);
  const closePanelDialog = usePanelDialogStore((state) => state.closePanelDialog);
  const promoteToGrid = usePanelDialogStore((state) => state.promoteToGrid);

  // Keyed read, not a subscription to the whole `panelsById` map: that map
  // churns on every panel update and would re-render the dialog with it.
  const panel = usePanelStore(
    useCallback((state) => (panelId ? state.panelsById[panelId] : undefined), [panelId])
  );

  const handlePromote = useCallback(() => {
    // A refused promotion (panel limit reached) leaves the dialog open and
    // surfaces its own notification from the store action.
    promoteToGrid();
  }, [promoteToGrid]);

  if (!panelId || !panel) return null;

  const definition = getPanelKindDefinition(panel.kind ?? "terminal");
  if (!definition) return null;

  const PanelComponent = definition.component;

  return (
    <AppDialog
      isOpen={true}
      onClose={closePanelDialog}
      size="6xl"
      maxHeight="max-h-[85vh]"
      data-testid="panel-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>{panel.title}</AppDialog.Title>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handlePromote}
            data-testid="panel-dialog-open-as-panel"
          >
            <PanelTop className="h-3.5 w-3.5" />
            Open as panel
          </Button>
          <AppDialog.CloseButton />
        </div>
      </AppDialog.Header>
      <AppDialog.Body className="flex min-h-0 flex-1 flex-col p-0">
        <ErrorBoundary
          variant="component"
          componentName={`PanelDialog:${panel.kind ?? "terminal"}`}
          resetKeys={[requestSeq]}
        >
          <PanelComponent
            id={panelId}
            title={panel.title}
            worktreeId={panel.worktreeId}
            isFocused={true}
            location="dialog"
            onFocus={noop}
            onClose={closePanelDialog}
          />
        </ErrorBoundary>
      </AppDialog.Body>
    </AppDialog>
  );
}

// Focus inside a dialog is owned by AppDialog's trap; the panel's grid focus
// pointer must not move, so `onFocus` is intentionally inert here.
function noop() {}
