import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { registerPanelCloseGuard, type PanelCloseVerdict } from "@/services/panelCloseGuard";
import {
  getViewUnsavedPanelIds,
  subscribeViewUnsavedChanges,
} from "@/services/plugin/pluginPanelLifecycle";
import { usePanelStore } from "@/store/panelStore";

/**
 * Holds the close of a plugin panel whose view reports unsaved work behind a
 * Discard / Cancel prompt (#13815). Mounted once per project view, outside
 * every pane, so a panel whose view is unmounted keeps its guard.
 *
 * The host owns the question and the answer: plugin code only raises the flag,
 * so it can neither veto a close nor hold one hostage. There is no Save — the
 * host cannot save a plugin's state — and a prompt whose panel stopped being
 * dirty underneath it answers Cancel, since the close it held is stale.
 */
interface Prompt {
  panelId: string;
  resolve: (verdict: PanelCloseVerdict) => void;
}

function getSnapshot(): string {
  return getViewUnsavedPanelIds().join("\n");
}

function panelTitle(panelId: string): string {
  return usePanelStore.getState().panelsById[panelId]?.title?.trim() || "this panel";
}

export function PluginPanelCloseGuardHost() {
  const dirtyIds = useSyncExternalStore(subscribeViewUnsavedChanges, getSnapshot, getSnapshot);
  const [queue, setQueue] = useState<Prompt[]>([]);
  const queueRef = useRef(queue);
  useLayoutEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    const ids = dirtyIds === "" ? [] : dirtyIds.split("\n");
    const disposers = ids.map((panelId) =>
      registerPanelCloseGuard(
        panelId,
        () =>
          new Promise<PanelCloseVerdict>((resolve) => {
            setQueue((current) => [...current, { panelId, resolve }]);
          })
      )
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [dirtyIds]);

  useEffect(() => {
    const dirty = new Set(dirtyIds === "" ? [] : dirtyIds.split("\n"));
    setQueue((current) => {
      const kept = current.filter((prompt) => {
        if (dirty.has(prompt.panelId)) return true;
        prompt.resolve("cancel");
        return false;
      });
      return kept.length === current.length ? current : kept;
    });
  }, [dirtyIds]);

  const settle = useCallback((prompt: Prompt, verdict: PanelCloseVerdict) => {
    if (!queueRef.current.includes(prompt)) return;
    prompt.resolve(verdict);
    setQueue((existing) => existing.filter((entry) => entry !== prompt));
  }, []);

  const prompt = queue[0] ?? null;
  if (!prompt) return null;

  return (
    <AppDialog
      isOpen
      onClose={() => settle(prompt, "cancel")}
      size="sm"
      zIndex="nested"
      initialFocus="cancel"
      data-testid="plugin-panel-close-prompt"
    >
      <AppDialog.Header>
        <AppDialog.Title>{`Discard unsaved changes in '${panelTitle(prompt.panelId)}'?`}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <AppDialog.Description>
          This panel has work it hasn't saved. Closing it discards that work.
        </AppDialog.Description>
      </AppDialog.Body>
      <AppDialog.Footer
        secondaryAction={{ label: "Cancel", onClick: () => settle(prompt, "cancel") }}
        primaryAction={{
          label: "Discard changes",
          onClick: () => settle(prompt, "proceed"),
          intent: "destructive",
        }}
      />
    </AppDialog>
  );
}
