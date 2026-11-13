import { createContext, useContext, useLayoutEffect } from "react";

/**
 * Content a deep link must not land on yet. Each mounted settings tab owns one, and
 * the dialog's landing waits while anything in the tab holds it.
 */
export interface SettingsDeepLinkHolds {
  /** Takes a hold; the returned function releases it, once. */
  hold: () => () => void;
  isHeld: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export function createSettingsDeepLinkHolds(): SettingsDeepLinkHolds {
  let count = 0;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    hold: () => {
      count += 1;
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        notify();
      };
    },
    isHeld: () => count > 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** A deep link waiting to land on the tab that's showing. */
export interface SettingsDeepLink {
  /** The section waiting to land on this tab, or null when none is, or the tab is hidden. */
  sectionId: string | null;
  /** What was typed into settings search when the link came from there. */
  query: string | null;
  holds: SettingsDeepLinkHolds | null;
}

const NO_DEEP_LINK: SettingsDeepLink = { sectionId: null, query: null, holds: null };

const SettingsDeepLinkContext = createContext<SettingsDeepLink>(NO_DEEP_LINK);

export const SettingsDeepLinkProvider = SettingsDeepLinkContext.Provider;

export function useSettingsDeepLink(): SettingsDeepLink {
  return useContext(SettingsDeepLinkContext);
}

/**
 * Keeps a deep link from landing while `held`, so a tab still loading its values isn't
 * searched before the setting it names has rendered. The hold is taken in a layout
 * effect: one taken on a tab's first commit is in place before the dialog's landing
 * effect, which runs after its children's, reads it. Outside a settings tab it does
 * nothing.
 */
export function useHoldSettingsDeepLink(held: boolean): void {
  const { holds } = useSettingsDeepLink();
  useLayoutEffect(() => {
    if (!held || !holds) return;
    return holds.hold();
  }, [held, holds]);
}

/** Holds for as long as it's mounted, as the fallback of content still loading in. */
export function SettingsDeepLinkHold(): null {
  useHoldSettingsDeepLink(true);
  return null;
}
