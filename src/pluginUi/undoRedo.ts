import { useLayoutEffect, useRef, useState } from "react";
import type {
  PluginUndoRedoPushOptions,
  UseUndoRedoOptions,
  UseUndoRedoResult,
} from "@shared/types/plugin-sdk-react";

export interface History<T> {
  past: readonly T[];
  present: T;
  future: readonly T[];
  /** The coalesce key of the last push and when it happened, while it can still merge. */
  last: { key: string; at: number } | null;
}

export interface HistoryLimits {
  limit: number;
  coalesceMs: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_COALESCE_MS = 1000;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], last: null };
}

/** A new present. A redo trail is dropped, as in every editor. */
export function pushHistory<T>(
  history: History<T>,
  next: T,
  key: string | undefined,
  now: number,
  limits: HistoryLimits
): History<T> {
  if (Object.is(next, history.present)) return history;
  const merges =
    key !== undefined &&
    history.last !== null &&
    history.last.key === key &&
    now - history.last.at <= limits.coalesceMs &&
    history.past.length > 0;
  if (merges) {
    return { past: history.past, present: next, future: [], last: { key, at: now } };
  }
  const past = [...history.past, history.present];
  return {
    past: past.length > limits.limit ? past.slice(past.length - limits.limit) : past,
    present: next,
    future: [],
    last: key === undefined ? null : { key, at: now },
  };
}

export function undoHistory<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    last: null,
  };
}

export function redoHistory<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return {
    past: [...history.past, history.present],
    present: next!,
    future: rest,
    last: null,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/** `reset()` rather than `reset(undefined)`, which is a value like any other. */
function given<T>(args: [value?: T]): args is [T] {
  return args.length > 0;
}

function isUpdater<T>(value: T | ((current: T) => T)): value is (current: T) => T {
  return typeof value === "function";
}

/**
 * A value with an undo history: `push` records a step, `undo` and `redo` walk
 * it. Pushes that share a `coalesce` key within `coalesceMs` merge into one
 * step, and past `limit` steps the oldest fall off. `undo` and `redo` return
 * the value they land on, so a caller can hand it straight to the worker.
 */
export function useUndoRedo<T>(
  initial: T | (() => T),
  rawOptions?: UseUndoRedoOptions
): UseUndoRedoResult<T> {
  const options: UseUndoRedoOptions =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const limits: HistoryLimits = {
    limit: Math.max(1, positiveInt(options.limit, DEFAULT_LIMIT)),
    coalesceMs: positiveInt(options.coalesceMs, DEFAULT_COALESCE_MS),
  };
  const [history, setHistory] = useState<History<T>>(() =>
    createHistory(isUpdater(initial) ? initial() : initial)
  );
  // The history every operation starts from: the last one committed, not the
  // one this render saw. Steps in one handler build on each other, and an
  // `undo` kept past later renders (an Undo toast's callback) still undoes the
  // newest step rather than restoring history from when it was captured.
  const latest = useRef<History<T> | null>(null);
  useLayoutEffect(() => {
    latest.current = history;
  }, [history]);
  const current = () => latest.current ?? history;
  const commit = (next: History<T>) => {
    latest.current = next;
    setHistory(next);
  };

  return {
    value: history.present,
    push: (next, pushOptions?: PluginUndoRedoPushOptions) => {
      const base = current();
      const value = isUpdater(next) ? next(base.present) : next;
      const key = typeof pushOptions?.coalesce === "string" ? pushOptions.coalesce : undefined;
      const updated = pushHistory(base, value, key, Date.now(), limits);
      if (updated !== base) commit(updated);
    },
    undo: () => {
      const base = current();
      if (base.past.length === 0) return undefined;
      const updated = undoHistory(base);
      commit(updated);
      return updated.present;
    },
    redo: () => {
      const base = current();
      if (base.future.length === 0) return undefined;
      const updated = redoHistory(base);
      commit(updated);
      return updated.present;
    },
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    reset: (...args: [value?: T]) => {
      commit(createHistory(given(args) ? args[0] : current().present));
    },
  };
}
