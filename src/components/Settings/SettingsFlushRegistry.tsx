import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { SettingsTab } from "./SettingsDialog";
import { logError } from "@/utils/logger";

/**
 * A flush that couldn't save — the draft is invalid, or the save failed — names the
 * element its draft and error sit in, so a close can stay open there instead of
 * dropping both. Returning nothing means the draft saved, or there was nothing to save.
 */
export interface SettingsFlushFailure {
  landOn: string;
}

export interface FailedSettingsFlush extends SettingsFlushFailure {
  tab: SettingsTab;
}

/**
 * A close is the user leaving. A hide (minimized, or the view cached by a project
 * switch) leaves Settings open, so a page whose write disrupts other things waits
 * for the close rather than doing it behind the user's back.
 */
export type SettingsFlushReason = "close" | "hide";

type FlushFn = (
  reason: SettingsFlushReason
) => void | SettingsFlushFailure | Promise<void | SettingsFlushFailure>;

interface FlushRegistryApi {
  register: (tab: SettingsTab, fn: FlushFn) => () => void;
  /** Runs every registered flush and resolves with the ones that kept their draft. */
  flushAll: (reason?: SettingsFlushReason) => Promise<FailedSettingsFlush[]>;
}

const FlushContext = createContext<FlushRegistryApi | null>(null);
export { FlushContext as SettingsFlushContext };

interface ProviderProps {
  children: ReactNode;
}

/**
 * Tracks per-tab flush callbacks so the dialog can persist any local dirty
 * state before dismissal. Mirrors the validation registry's shape; tabs that
 * own their own dirty buffer (env vars, worktree pattern) register a flush
 * function while dirty and unregister when clean or unmounted.
 */
export function SettingsFlushProvider({ children }: ProviderProps) {
  // A page can hold several drafts of its own: Integrations has the editor and the
  // image viewer, each registering while it is pending.
  const flushersRef = useRef<Set<{ tab: SettingsTab; fn: FlushFn }>>(new Set());

  const register = useCallback((tab: SettingsTab, fn: FlushFn) => {
    const flusher = { tab, fn };
    flushersRef.current.add(flusher);
    return () => {
      flushersRef.current.delete(flusher);
    };
  }, []);

  const flushAll = useCallback(async (reason: SettingsFlushReason = "close") => {
    const failed: FailedSettingsFlush[] = [];
    // One at a time: several of these rewrite the whole project settings file from a
    // copy they read first, so two running together can undo each other's write.
    for (const { tab, fn } of Array.from(flushersRef.current)) {
      try {
        const failure = await fn(reason);
        if (failure) failed.push({ tab, landOn: failure.landOn });
      } catch (err) {
        // A flush that throws has no message on its page, so holding the dialog
        // open on it would leave Settings unclosable with nothing saying why.
        logError("Settings flush failed", err);
      }
    }
    return failed;
  }, []);

  const value = useMemo(() => ({ register, flushAll }), [register, flushAll]);

  return <FlushContext.Provider value={value}>{children}</FlushContext.Provider>;
}

/**
 * Registers `fn` as the flush callback for `tab` while `enabled` is true.
 * Each tab owns its own validate/in-flight gates inside `fn`. Tolerates a
 * missing provider so tabs remain renderable in isolation (storybook, unit
 * tests) — the only consequence is that flushAll won't pick up the callback.
 */
export function useSettingsTabFlush(tab: SettingsTab, fn: FlushFn, enabled: boolean): void {
  const ctx = useContext(FlushContext);
  const register = ctx?.register;

  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled || !register) return;
    return register(tab, (reason) => fnRef.current(reason));
  }, [enabled, register, tab]);
}
