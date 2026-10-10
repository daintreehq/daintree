import { useCallback } from "react";
import { useDoubleShift } from "@/hooks/useDoubleShift";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useCanopyStore } from "@/store/canopyStore";
import { actionService } from "@/services/ActionService";

/**
 * Double-Shift opens Canopy: the gesture that reaches the app's main view from
 * anywhere, terminal included, with nothing to remember per platform. Off in
 * Settings → Keyboard for anyone it fires on by accident (Sticky Keys, an IME
 * that leans on Shift).
 *
 * Only once Canopy is on. Before then a stray double tap — typing capitals
 * quickly is enough — would put the offer in front of someone who never asked
 * for it; Cmd+E and the toolbar button are the deliberate ways to find it.
 */
export function useCanopyDoubleShift(): void {
  const enabled = usePreferencesStore((s) => s.doubleShiftOpensCanopy);
  const on = useCanopyStore((s) => s.mode === "on");
  const toggle = useCallback(() => {
    void actionService.dispatch("canopy.toggle", undefined, { source: "keybinding" });
  }, []);
  useDoubleShift(toggle, enabled && on);
}
