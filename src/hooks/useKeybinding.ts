import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { keybindingService, type KeyScope } from "../services/KeybindingService";
import { comboToAriaKeyshortcuts } from "../lib/kbdShortcut";
import { useKeyLabels } from "../lib/keyboardLayout";
import { isMac } from "../lib/platform";

const subscribeToKeybindings = (listener: () => void): (() => void) =>
  keybindingService.subscribe(listener);

export function useKeybindingScope(scope: KeyScope, active: boolean = true): void {
  useEffect(() => {
    if (!active) return;

    keybindingService.setScope(scope);

    return () => {
      keybindingService.restoreScope(scope);
    };
  }, [scope, active]);
}

export function useKeybindingDisplay(actionId: string): string {
  const getSnapshot = useCallback(() => keybindingService.getDisplayCombo(actionId), [actionId]);
  return useSyncExternalStore(subscribeToKeybindings, getSnapshot);
}

export function useEffectiveCombo(actionId: string): string | undefined {
  const getSnapshot = useCallback(() => keybindingService.getEffectiveCombo(actionId), [actionId]);
  return useSyncExternalStore(subscribeToKeybindings, getSnapshot);
}

/**
 * Returns the canonical combo for `actionId` formatted for `aria-keyshortcuts`
 * (e.g. `"Meta+Shift+P"` on macOS, `"Control+Shift+P"` on Win/Linux). Returns
 * `undefined` when no binding exists so callers can spread `aria-keyshortcuts`
 * conditionally without rendering an empty attribute.
 */
export function useAriaKeyshortcuts(actionId: string): string | undefined {
  const combo = useEffectiveCombo(actionId);
  const keyLabels = useKeyLabels();
  const mac = useMemo(() => isMac(), []);
  return useMemo(() => comboToAriaKeyshortcuts(combo, mac, keyLabels), [combo, mac, keyLabels]);
}

export { keybindingService };
