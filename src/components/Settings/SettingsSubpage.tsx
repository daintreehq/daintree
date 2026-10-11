import { createContext, use, useEffect, useLayoutEffect, useRef } from "react";

/** A page opened from inside a settings tab: one host's details under Hosts. */
export interface SettingsSubpage {
  /** What the subpage is about, shown after the tab's own title. */
  title: string;
  /** The tab it returns to, which names the back control. */
  parentLabel: string;
  /** `viaKeyboard`: the way back was taken from the keyboard, so focus lands visibly. */
  onBack: (viaKeyboard: boolean) => void;
}

type SetSubpage = (subpage: SettingsSubpage | null) => void;

const SettingsSubpageContext = createContext<SetSubpage | null>(null);

export const SettingsSubpageProvider = SettingsSubpageContext.Provider;

/**
 * Puts a subpage's title and back control in the settings header, which
 * stays put while the page scrolls. Returns whether a header took it: outside
 * the settings dialog the page keeps its own back control.
 */
export function useSettingsSubpage(subpage: SettingsSubpage | null): boolean {
  const set = use(SettingsSubpageContext);
  const onBack = useRef(subpage?.onBack);
  const latestBack = subpage?.onBack;
  useLayoutEffect(() => {
    onBack.current = latestBack;
  }, [latestBack]);
  const title = subpage?.title ?? null;
  const parentLabel = subpage?.parentLabel ?? null;

  useEffect(() => {
    if (!set) return;
    if (title === null || parentLabel === null) {
      set(null);
      return;
    }
    set({ title, parentLabel, onBack: (viaKeyboard) => onBack.current?.(viaKeyboard) });
    return () => set(null);
  }, [set, title, parentLabel]);

  return set !== null;
}
