/**
 * App handlers registrar - delegates to domain-specific handler modules.
 *
 * This file previously contained all app-related handlers mixed together.
 * The handlers have been split into focused modules:
 * - app/state.ts - App state (hydrate, get/set state, version)
 * - logs.ts - Log buffer operations
 * - eventInspector.ts - Event inspector operations
 * - terminalConfig.ts - Terminal configuration
 */

import type { HandlerDependencies } from "../types.js";
import { registerAppStateHandlers } from "./app/state.js";
import { registerLogsHandlers } from "./logs.js";
import { registerEventInspectorHandlers } from "./eventInspector.js";
import { registerTerminalConfigHandlers } from "./terminalConfig.js";
import { registerAppThemeHandlers } from "./appTheme.js";

export function registerAppHandlers(deps: HandlerDependencies): () => void {
  const cleanups = [
    registerAppStateHandlers(),
    registerLogsHandlers(),
    registerEventInspectorHandlers(deps),
    registerTerminalConfigHandlers(),
    registerAppThemeHandlers(),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}
