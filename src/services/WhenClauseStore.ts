import type { WhenClauseContext, ContextKeyValue } from "@shared/utils/whenClause/types";

export interface WhenClauseStoreState {
  context: WhenClauseContext;
  setContext: (key: string, value: ContextKeyValue) => void;
  setContextBulk: (partial: WhenClauseContext) => void;
  getSnapshot: () => WhenClauseContext;
}

export function createWhenClauseStoreState(): WhenClauseStoreState {
  const context: WhenClauseContext = {};

  return {
    context,
    setContext(key, value) {
      context[key] = value;
    },
    setContextBulk(partial) {
      Object.assign(context, partial);
    },
    getSnapshot() {
      return { ...context };
    },
  };
}
