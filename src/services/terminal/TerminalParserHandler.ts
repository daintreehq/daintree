import { getAgentConfig } from "@/config/agents";
import { ManagedTerminal } from "./types";
import { TerminalKind } from "@/types";

/**
 * Set up xterm.js parser hooks to intercept and block problematic sequences.
 * This is more robust than regex filtering as it handles stream chunking correctly.
 */
export function setupParserHandlers(managed: ManagedTerminal): void {
  const kind: TerminalKind | undefined = managed.kind;
  const agentId = managed.agentId;
  if (kind !== "agent" && managed.type !== "claude") return;

  const agentConfig = agentId ? getAgentConfig(agentId) : null;
  const shouldBlockSequences =
    agentConfig?.capabilities?.blockAltScreen || agentConfig?.capabilities?.blockMouseReporting;

  // Helper to check if we should block the sequence
  const shouldBlock = () => {
    // Block for configured agent terminals to prevent TUI mode hijacking and bouncing
    return shouldBlockSequences ?? false;
  };

  // 1. Intercept DECSET (CSI ? ... h) - Enable Mode
  managed.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (!shouldBlock()) return false;

    // Block Mouse Tracking (1000, 1002, 1003, 1006)
    // Block Alt Screen (1049, 1047, 1048, 47)
    const blockList = [1000, 1002, 1003, 1006, 1049, 1047, 1048, 47];
    const hasBlockedParam = params.some((p) => {
      // xterm.js params are (number | number[])[]
      const val = typeof p === "number" ? p : p[0];
      return blockList.includes(val);
    });

    return hasBlockedParam; // true = handled (swallowed), false = pass to default
  });

  // 2. Intercept DECRST (CSI ? ... l) - Disable Mode
  managed.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (!shouldBlock()) return false;

    // Same block list for disabling
    const blockList = [1000, 1002, 1003, 1006, 1049, 1047, 1048, 47];
    const hasBlockedParam = params.some((p) => {
      const val = typeof p === "number" ? p : p[0];
      return blockList.includes(val);
    });

    return hasBlockedParam;
  });

  // 3. Intercept DECSTBM (CSI ... r) - Set Scroll Region
  managed.terminal.parser.registerCsiHandler({ final: "r" }, () => {
    if (!shouldBlock()) return false;
    // Block ALL scroll region changes for Claude to keep the buffer linear
    return true;
  });

  // 4. Intercept ED (CSI ... J) - Erase in Display
  managed.terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
    if (!shouldBlock()) return false;

    // Block '2' (Clear Screen) and '3' (Clear Scrollback)
    // This prevents the "blank slate" effect that usually precedes a jump-to-top
    const hasBlockedParam = params.some((p) => {
      const val = typeof p === "number" ? p : p[0];
      return val === 2 || val === 3;
    });

    return hasBlockedParam;
  });

  // 5. Intercept CUP (CSI ... H) and HVP (CSI ... f) - Cursor Position
  // Block attempts to move cursor to the top row (Row 1), which causes viewport jumping
  const handleCursorMove = (params: (number | number[])[]) => {
    if (!shouldBlock()) return false;

    // Default is 1;1 if no params
    if (params.length === 0) return true;

    // Check Row (1st param)
    const row = typeof params[0] === "number" ? params[0] : params[0][0];

    // Block if explicit Row 1, Row 0 (treated as 1), or undefined (implies 1)
    if (row === 0 || row === 1 || row === undefined) {
      return true;
    }
    return false;
  };

  managed.terminal.parser.registerCsiHandler({ final: "H" }, handleCursorMove);
  managed.terminal.parser.registerCsiHandler({ final: "f" }, handleCursorMove);
}
