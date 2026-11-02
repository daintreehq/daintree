import { events } from "../events.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";

/**
 * How a wait for an agent's prompt ended, with the last state observed for
 * its terminal. What was observed, never a judgement that typing is safe.
 *
 * - `settled`: the agent was observed `waiting` or `idle`, which the state
 *   machine reads off its output and can get wrong. `waitingReason` says what
 *   kind of wait: `prompt` is usually its own input prompt, while `approval`,
 *   `question` and `error` are something else on screen.
 * - `exited`: the agent was observed exiting, or its spawn failing.
 * - `closed`: the agent's terminal was killed.
 * - `timeout`, `aborted`: neither happened in time, or the caller gave up.
 */
export interface AgentPromptWaitResult {
  terminalId: string;
  outcome: "settled" | "exited" | "closed" | "timeout" | "aborted";
  state?: AgentState;
  waitingReason?: WaitingReason;
}

/**
 * Wait until the agent in `terminalId` is observed at rest, for one main
 * launched or found (#16000). A launch reads as `working` from its spawn
 * until the state machine first sees its prompt, so a terminal not yet
 * announced is waited for rather than read as idle, and `completed`, which a
 * prompt follows, never ends the wait. A timeout leaves the agent running.
 *
 * `promptOnly` settles only on `waiting` for its `prompt`: `idle` (which can
 * be a bare shell) and the other kinds of wait are passed through, so an
 * approval on screen keeps the wait going until the prompt follows it.
 */
export function waitForAgentAtPrompt(
  terminalId: string,
  options: { timeoutMs: number; signal?: AbortSignal; promptOnly?: boolean }
): Promise<AgentPromptWaitResult> {
  const store = getAgentAvailabilityStore();
  const { signal } = options;
  return new Promise((resolve) => {
    let observed: { state?: AgentState; waitingReason?: WaitingReason } = {};
    const unsubscribers: Array<() => void> = [];
    let settled = false;

    const timer = setTimeout(() => finish("timeout"), Math.max(0, options.timeoutMs));
    const onAbort = () => finish("aborted");
    const finish = (outcome: AgentPromptWaitResult["outcome"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const off of unsubscribers) off();
      signal?.removeEventListener("abort", onAbort);
      resolve({ terminalId, outcome, ...observed });
    };
    const listen = (off: () => void) => {
      if (settled) off();
      else unsubscribers.push(off);
    };
    const observe = (
      state: AgentState,
      waitingReason: WaitingReason | undefined,
      trigger?: string
    ) => {
      observed = { state, ...(state === "waiting" && waitingReason ? { waitingReason } : {}) };
      // A kill resets the agent to idle just before it announces the kill.
      if (state === "idle" && trigger === "exit") return;
      const atRest =
        options.promptOnly === true
          ? state === "waiting" && waitingReason === "prompt"
          : state === "waiting" || state === "idle";
      if (atRest) finish("settled");
      else if (state === "exited") finish("exited");
    };

    // Read straight off each event, so the answer never depends on whether
    // the availability store's own listener ran first.
    listen(
      events.on("agent:state-changed", (payload) => {
        if (payload.terminalId === terminalId) {
          observe(payload.state, payload.waitingReason, payload.trigger);
        }
      })
    );
    listen(
      events.on("agent:spawned", (payload) => {
        if (payload.terminalId === terminalId) observed = { state: "working" };
      })
    );
    listen(
      events.on("agent:killed", (payload) => {
        if (payload.terminalId === terminalId) finish("closed");
      })
    );

    // A caller that has already given up gets that, whatever the agent is doing.
    if (signal?.aborted) {
      finish("aborted");
      return;
    }
    // Read again now that nothing can slip past the listeners.
    if (store.isTerminalClosed(terminalId)) {
      finish("closed");
      return;
    }
    const current = store.getTerminalSnapshot(terminalId);
    if (current) observe(current.state, current.waitingReason);
    if (settled) return;
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
