import { useCallback } from "react";
import { useDoubleShift } from "@/hooks/useDoubleShift";
import { usePreferencesStore } from "@/store/preferencesStore";
import { actionService } from "@/services/ActionService";

/**
 * Double-Shift opens Canopy: the gesture that reaches the app's main view from
 * anywhere, terminal included, with nothing to remember per platform. Off in
 * Settings → Keyboard for anyone it fires on by accident (Sticky Keys, an IME
 * that leans on Shift).
 */
export function useCanopyDoubleShift(): void {
  const enabled = usePreferencesStore((s) => s.doubleShiftOpensCanopy);
  const toggle = useCallback(() => {
    void actionService.dispatch("canopy.toggle", undefined, { source: "keybinding" });
  }, []);
  useDoubleShift(toggle, enabled);
}
