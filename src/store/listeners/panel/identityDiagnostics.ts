import { usePanelStore } from "@/store/panelStore";

// Circular log of identity events for live diagnostics. Open devtools and
// call `__daintreeIdentityEvents()` to inspect the last N detected/exited
// events per terminal. The log is append-only, capped, and has no effect
// on store behavior. Every function body is gated by `import.meta.env.DEV`
// so Rolldown DCE strips the writes and `window` global installation in
// production builds; the empty ring buffer allocation itself is harmless.
const IDENTITY_LOG_CAP = 200;

interface IdentityEventEntry {
  at: number;
  kind: "detected" | "exited";
  terminalId: string;
  agentType?: string;
  processIconId?: string;
}

const _identityLog: IdentityEventEntry[] = [];

export function recordIdentityEventDev(
  kind: "detected" | "exited",
  terminalId: string,
  detail: { agentType?: string; processIconId?: string }
): void {
  if (!import.meta.env.DEV) return;

  const entry: IdentityEventEntry = {
    at: Date.now(),
    kind,
    terminalId,
    agentType: detail.agentType,
    processIconId: detail.processIconId,
  };
  _identityLog.push(entry);
  if (_identityLog.length > IDENTITY_LOG_CAP) _identityLog.shift();

  // Every detection/exit event lands in the browser devtools console so a
  // user reporting "chrome didn't update" can dump the live trail without
  // needing to open the main-process log. Prefix stays searchable.
  console.log(
    `[IdentityDebug] ${kind} term=${terminalId.slice(-8)} agent=${detail.agentType ?? "<none>"} icon=${detail.processIconId ?? "<none>"}`
  );

  if (typeof window !== "undefined") {
    const w = window as unknown as {
      __daintreeIdentityEvents?: () => IdentityEventEntry[];
      __daintreeIdentityState?: () => Array<{
        terminalId: string;
        title: string;
        launchAgentId?: string;
        detectedAgentId?: string;
        everDetectedAgent?: boolean;
        detectedProcessId?: string;
        runtimeIdentity?: unknown;
        agentState?: string;
      }>;
    };
    if (!w.__daintreeIdentityEvents) {
      w.__daintreeIdentityEvents = () => _identityLog.slice();
    }
    if (!w.__daintreeIdentityState) {
      w.__daintreeIdentityState = () => {
        const panels = usePanelStore.getState().panelsById;
        return Object.values(panels).map((p) => {
          const terminal = p as {
            id: string;
            title: string;
            launchAgentId?: string;
            detectedAgentId?: string;
            everDetectedAgent?: boolean;
            detectedProcessId?: string;
            runtimeIdentity?: unknown;
            agentState?: string;
          };
          return {
            terminalId: terminal.id,
            title: terminal.title,
            launchAgentId: terminal.launchAgentId,
            detectedAgentId: terminal.detectedAgentId,
            everDetectedAgent: terminal.everDetectedAgent,
            detectedProcessId: terminal.detectedProcessId,
            runtimeIdentity: terminal.runtimeIdentity,
            agentState: terminal.agentState,
          };
        });
      };
    }
  }
}

export function logIdentityDebugDev(message: string): void {
  if (!import.meta.env.DEV) return;
  console.log(message);
}
