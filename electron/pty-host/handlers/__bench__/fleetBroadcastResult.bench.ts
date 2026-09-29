// Fleet broadcast result traffic: one armed fleet typing through the real
// pty-host `broadcast-write` handler and the real Main relay in
// `registerTerminalEventHandlers`. Counts are modelled, not measured on the
// wire: host messages are `sendEvent` calls, renderer sends are relay calls
// times the views each reaches, and bytes are JSON payload lengths.
//
//   npx vitest bench --run electron/pty-host/handlers/__bench__/fleetBroadcastResult.bench.ts
import { afterAll, bench, describe, vi } from "vitest";
import { EventEmitter } from "events";
import type { BroadcastWriteResultPayload } from "../../../../shared/types/pty-host.js";

const TARGETS = 20;
const KEYSTROKES = 100;
const FAIL_AT = 40;

// Three open project views; the fleet lives in one of them. `deliver` is the
// fleet view's result handler, so the chip model only sees what the relay
// actually sends it.
const relay = vi.hoisted(() => ({
  windows: 3,
  sends: 0,
  bytes: 0,
  deliver: (_payload: BroadcastWriteResultPayload) => {},
}));

vi.mock("../../../ipc/utils.js", () => {
  const send = (views: number, payload: BroadcastWriteResultPayload) => {
    relay.sends += views;
    relay.bytes += views * JSON.stringify(payload).length;
    relay.deliver(payload);
  };
  return {
    broadcastToRenderer: (_channel: string, payload: BroadcastWriteResultPayload) =>
      send(relay.windows, payload),
    broadcastToProjectRenderers: (
      projectId: string | null,
      _channel: string,
      payload: BroadcastWriteResultPayload
    ) => send(projectId === null ? relay.windows : 1, payload),
    broadcastToProjectRenderersExcept: () => {},
  };
});
vi.mock("../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn() },
}));
vi.mock("../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../services/events.js", () => ({
  events: { on: vi.fn(() => vi.fn()), emit: vi.fn() },
}));

import { createTerminalIOHandlers } from "../terminalIO.js";
import { registerTerminalEventHandlers } from "../../../ipc/handlers/terminal/events.js";
import type { HostContext } from "../types.js";
import type { HandlerDependencies } from "../../../ipc/types.js";

interface Metrics {
  hostMessages: number;
  hostBytes: number;
  rendererSends: number;
  rendererBytes: number;
  chipClearedBy: number | null;
}

interface Scenario {
  /** Keystroke whose write to t3 fails with EAGAIN; the next one succeeds. */
  failAt: number | null;
  /**
   * Results reach the renderer only after the next keystroke has been sent,
   * so the recovery keystroke leaves before the failure chip exists.
   */
  lateDelivery: boolean;
}

// Mirrors the chip bookkeeping in `applyFleetBroadcastResult`: transient
// failures replace the set, a success for a failed id dismisses it.
function runScenario({ failAt, lateDelivery }: Scenario): Metrics {
  const ids = Array.from({ length: TARGETS }, (_, i) => `t${i}`);
  const failing = new Set<string>();
  const chip = new Set<string>();
  let chipClearedBy: number | null = null;
  const inbox: Array<{ keystroke: number; payload: BroadcastWriteResultPayload }> = [];
  let sending = 0;

  const apply = (keystroke: number, payload: BroadcastWriteResultPayload) => {
    const transient: string[] = [];
    for (const r of payload.results) {
      if (r.ok) {
        if (chip.delete(r.id) && chip.size === 0) chipClearedBy = keystroke;
      } else transient.push(r.id);
    }
    if (transient.length > 0) {
      chip.clear();
      for (const id of transient) chip.add(id);
    }
  };
  relay.deliver = (payload) => {
    if (lateDelivery) inbox.push({ keystroke: sending, payload });
    else apply(sending, payload);
  };

  const ptyClient = Object.assign(new EventEmitter(), {
    getTerminalProjectId: () => "project-a",
  });
  const dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);

  const m = { hostMessages: 0, hostBytes: 0 };
  const ptyManager = {
    getTerminal: () => ({ wasKilled: false, isExited: false }),
    tryWrite: (id: string) =>
      failing.has(id)
        ? { ok: false, error: Object.assign(new Error("try again"), { code: "EAGAIN" }) }
        : { ok: true },
  };
  const ctx = {
    ptyManager,
    sendEvent: (event: { type: string; results: unknown }) => {
      m.hostMessages++;
      m.hostBytes += JSON.stringify(event).length;
      ptyClient.emit(event.type, { results: event.results });
    },
  } as unknown as HostContext;
  const handler = createTerminalIOHandlers(ctx)["broadcast-write"]!;

  relay.sends = 0;
  relay.bytes = 0;
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (sending = 0; sending < KEYSTROKES; sending++) {
    if (failAt !== null) {
      if (sending === failAt) failing.add("t3");
      if (sending === failAt + 1) failing.delete("t3");
    }
    const pending = inbox.splice(0);
    handler({ type: "broadcast-write", ids, data: "a", reportSuccess: chip.size > 0 });
    for (const { keystroke, payload } of pending) apply(keystroke, payload);
  }
  for (const { keystroke, payload } of inbox.splice(0)) apply(keystroke, payload);
  errSpy.mockRestore();
  dispose();

  if (failAt !== null && chipClearedBy !== failAt + 1) {
    throw new Error(`chip was not cleared by the recovery keystroke (cleared by ${chipClearedBy})`);
  }
  return {
    ...m,
    rendererSends: relay.sends,
    rendererBytes: relay.bytes,
    chipClearedBy,
  };
}

const report: Record<string, Metrics> = {};

describe(`fleet broadcast results — ${TARGETS} targets × ${KEYSTROKES} keystrokes`, () => {
  bench("all targets succeed", () => {
    report["all-ok"] = runScenario({ failAt: null, lateDelivery: false });
  });
  bench("transient failure then recovery", () => {
    report["fail→recover"] = runScenario({ failAt: FAIL_AT, lateDelivery: false });
  });
  bench("transient failure then recovery, results in flight", () => {
    report["fail→recover (late)"] = runScenario({ failAt: FAIL_AT, lateDelivery: true });
  });
});

afterAll(() => {
  process.stdout.write("\nFLEET_RESULT_METRICS " + JSON.stringify(report) + "\n");
});
