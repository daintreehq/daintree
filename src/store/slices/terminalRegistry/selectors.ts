import type { TerminalInstance } from "./types";

let _prevById: Record<string, TerminalInstance> | null = null;
let _prevIds: string[] | null = null;
let _prevResult: TerminalInstance[] | null = null;

export function selectOrderedTerminals(
  terminalsById: Record<string, TerminalInstance>,
  terminalIds: string[]
): TerminalInstance[] {
  if (terminalsById === _prevById && terminalIds === _prevIds && _prevResult) {
    return _prevResult;
  }
  _prevById = terminalsById;
  _prevIds = terminalIds;
  _prevResult = terminalIds.map((id) => terminalsById[id]).filter(Boolean);
  return _prevResult;
}

export function _resetSelectorCacheForTests(): void {
  _prevById = null;
  _prevIds = null;
  _prevResult = null;
}
