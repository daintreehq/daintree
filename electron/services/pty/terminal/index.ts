export {
  chunkInput,
  isBracketedPaste,
  normalizeSubmitText,
  splitTrailingNewlines,
  isGeminiTerminal,
  isCodexTerminal,
  supportsBracketedPaste,
  getSoftNewlineSequence,
  wrapInBracketedPaste,
  InputWriteQueue,
  WRITE_MAX_CHUNK_SIZE,
  WRITE_INTERVAL_MS,
  SUBMIT_BRACKETED_PASTE_THRESHOLD_CHARS,
  SUBMIT_ENTER_DELAY_MS,
} from "./TerminalInputHandler.js";
export type { InputQueueCallbacks } from "./TerminalInputHandler.js";

export { TerminalFlowController } from "./TerminalFlowController.js";
export type { FlowControlCallbacks } from "./TerminalFlowController.js";

export { TerminalSessionManager } from "./TerminalSessionManager.js";
export type { SessionManagerOptions } from "./TerminalSessionManager.js";

export { TerminalSnapshotEngine } from "./TerminalSnapshotEngine.js";
export type { SnapshotEngineOptions } from "./TerminalSnapshotEngine.js";
