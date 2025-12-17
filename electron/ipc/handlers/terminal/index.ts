/**
 * Terminal handlers - Composes all terminal-related IPC handlers.
 *
 * Extracted from the monolithic terminal.ts into focused modules:
 * - lifecycle.ts: spawn, kill, trash, restore
 * - io.ts: input, resize, submit, sendKey, acknowledge, forceResume
 * - snapshots.ts: getSnapshot, getCleanLog, getSerializedState, wake, getInfo
 * - events.ts: forwards events to renderer
 * - artifacts.ts: save to file, apply patch
 */

import type { HandlerDependencies } from "../../types.js";
import { registerTerminalLifecycleHandlers } from "./lifecycle.js";
import { registerTerminalIOHandlers } from "./io.js";
import { registerTerminalSnapshotHandlers } from "./snapshots.js";
import { registerTerminalEventHandlers } from "./events.js";
import { registerArtifactHandlers } from "./artifacts.js";

export function registerTerminalHandlers(deps: HandlerDependencies): () => void {
  const cleanups = [
    registerTerminalLifecycleHandlers(deps),
    registerTerminalIOHandlers(deps),
    registerTerminalSnapshotHandlers(deps),
    registerTerminalEventHandlers(deps),
    registerArtifactHandlers(deps),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}
