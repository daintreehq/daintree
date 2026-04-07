import type { TerminalInstance } from "./types";

let _prevById: Record<string, TerminalInstance> | null = null;
let _prevIds: string[] | null = null;
let _prevResult: TerminalInstance[] | null = null;

export function selectOrderedTerminals(
  panelsById: Record<string, TerminalInstance>,
  panelIds: string[]
): TerminalInstance[] {
  if (panelsById === _prevById && panelIds === _prevIds && _prevResult) {
    return _prevResult;
  }
  _prevById = panelsById;
  _prevIds = panelIds;
  _prevResult = panelIds.map((id) => panelsById[id]).filter(Boolean);
  return _prevResult;
}

export function _resetSelectorCacheForTests(): void {
  _prevById = null;
  _prevIds = null;
  _prevResult = null;
}
