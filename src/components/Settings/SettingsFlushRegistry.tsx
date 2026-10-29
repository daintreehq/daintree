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

type FlushFn = () => void | SettingsFlushFailure | Promise<void | SettingsFlushFailure>;

interface FlushRegistryApi {
  register: (tab: SettingsTab, fn: FlushFn) => () => void;
  /** Runs every registered flush and resolves with the ones that kept their draft. */
  flushAll: () => Promise<FailedSettingsFlush[]>;
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
  const flushersRef = useRef<Map<SettingsTab, FlushFn>>(new Map());

  const register = useCallback((tab: SettingsTab, fn: FlushFn) => {
    flushersRef.current.set(tab, fn);
    return () => {
      const current = flushersRef.current.get(tab);
      // Only delete if we still own the slot — a re-register from the same tab
      // would have replaced fn, and we shouldn't blow away the new one.
      if (current === fn) {
        flushersRef.current.delete(tab);
      }
    };
  }, []);

  const flushAll = useCallback(async () => {
    const flushers = Array.from(flushersRef.current.entries());
    const outcomes = await Promise.all(
      flushers.map(async ([tab, fn]): Promise<FailedSettingsFlush | null> => {
        try {
          const failure = await fn();
          return failure ? { tab, landOn: failure.landOn } : null;
        } catch (err) {
          // A flush that throws has no message on its page, so holding the dialog
          // open on it would leave Settings unclosable with nothing saying why.
          logError("Settings flush failed", err);
          return null;
        }
      })
    );
    return outcomes.filter((outcome): outcome is FailedSettingsFlush => outcome !== null);
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
    return register(tab, () => fnRef.current());
  }, [enabled, register, tab]);
}
