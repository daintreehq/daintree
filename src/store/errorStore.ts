import { create, type StateCreator } from "zustand";

export type ErrorType = "git" | "process" | "filesystem" | "network" | "config" | "unknown";

export type RetryAction = "terminal" | "git" | "worktree";

export interface AppError {
  id: string;
  timestamp: number;
  type: ErrorType;
  message: string;
  details?: string;
  source?: string;
  context?: {
    worktreeId?: string;
    terminalId?: string;
    filePath?: string;
    command?: string;
  };
  isTransient: boolean;
  dismissed: boolean;
  retryAction?: RetryAction;
  retryArgs?: Record<string, unknown>;
}

interface ErrorStore {
  errors: AppError[];
  isPanelOpen: boolean;
  lastErrorTime: number;

  addError: (error: Omit<AppError, "id" | "timestamp" | "dismissed">) => string;
  dismissError: (id: string) => void;
  clearAll: () => void;
  removeError: (id: string) => void;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  getWorktreeErrors: (worktreeId: string) => AppError[];
  getTerminalErrors: (terminalId: string) => AppError[];
  getActiveErrors: () => AppError[];
  reset: () => void;
}

const MAX_ERRORS = 50;
const ERROR_RATE_LIMIT_MS = 500;

function generateErrorId(): string {
  return `error-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const createErrorStore: StateCreator<ErrorStore> = (set, get) => ({
  errors: [],
  isPanelOpen: false,
  lastErrorTime: 0,

  addError: (error) => {
    const now = Date.now();
    const state = get();

    // Deduplicate rapid-fire errors with same type/message/context to avoid UI flooding
    const recentDuplicate = state.errors.find(
      (e) =>
        !e.dismissed &&
        e.type === error.type &&
        e.message === error.message &&
        e.source === error.source &&
        e.context?.terminalId === error.context?.terminalId &&
        e.context?.worktreeId === error.context?.worktreeId &&
        now - e.timestamp < ERROR_RATE_LIMIT_MS
    );

    if (recentDuplicate) {
      set((s) => ({
        errors: s.errors.map((e) => (e.id === recentDuplicate.id ? { ...e, timestamp: now } : e)),
        lastErrorTime: now,
      }));
      return recentDuplicate.id;
    }

    const newError: AppError = {
      ...error,
      id: generateErrorId(),
      timestamp: now,
      dismissed: false,
    };

    set((state) => {
      const newErrors = [newError, ...state.errors].slice(0, MAX_ERRORS);
      return {
        errors: newErrors,
        lastErrorTime: now,
      };
    });

    return newError.id;
  },

  dismissError: (id) => {
    set((state) => ({
      errors: state.errors.map((e) => (e.id === id ? { ...e, dismissed: true } : e)),
    }));
  },

  clearAll: () => {
    set({
      errors: [],
      isPanelOpen: false,
      lastErrorTime: 0,
    });
  },

  removeError: (id) => {
    set((state) => ({
      errors: state.errors.filter((e) => e.id !== id),
    }));
  },

  togglePanel: () => {
    set((state) => ({ isPanelOpen: !state.isPanelOpen }));
  },

  setPanelOpen: (open) => {
    set({ isPanelOpen: open });
  },

  getWorktreeErrors: (worktreeId) => {
    return get().errors.filter((e) => e.context?.worktreeId === worktreeId && !e.dismissed);
  },

  getTerminalErrors: (terminalId) => {
    return get().errors.filter((e) => e.context?.terminalId === terminalId && !e.dismissed);
  },

  getActiveErrors: () => {
    return get().errors.filter((e) => !e.dismissed);
  },

  reset: () =>
    set({
      errors: [],
      isPanelOpen: false,
      lastErrorTime: 0,
    }),
});

export const useErrorStore = create<ErrorStore>()(createErrorStore);
