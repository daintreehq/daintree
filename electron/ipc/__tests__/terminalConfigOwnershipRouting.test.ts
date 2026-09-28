import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), fromWebContents: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
}));

/**
 * Two machines' stores. Whichever is `current` is the one `store` reads and
 * writes: this machine's while a handler runs here, the host's while a
 * forwarded call runs there.
 */
const machines = vi.hoisted(() => {
  const shell: Record<string, unknown> = { terminalConfig: {} };
  const host: Record<string, unknown> = { terminalConfig: {} };
  return { shell, host, current: shell };
});

vi.mock("../../store.js", () => {
  const read = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (value, part) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined,
        machines.current
      );
  const write = (key: string, value: unknown): void => {
    const parts = key.split(".");
    const last = parts.pop()!;
    let target = machines.current;
    for (const part of parts) {
      if (typeof target[part] !== "object" || target[part] === null) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[last] = value;
  };
  return { store: { get: vi.fn(read), set: vi.fn(write) } };
});

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { StoreSchema } from "../../store.js";
import { TERMINAL_CONFIG_FIELD_OWNERSHIP } from "../../storeOwnership.js";
import { CHANNELS } from "../channels.js";
import { _resetIpcDispatcherForTesting, getIpcDispatcher } from "../dispatcher.js";
import type { EndpointInvocation, RemoteRouter } from "../endpoint.js";
import { registerTerminalConfigHandlers } from "../handlers/terminalConfig.js";

type TerminalConfigField = keyof StoreSchema["terminalConfig"];
type LocalListener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const REMOTE_SENDER = 5;
const HOST = "studio";

/**
 * One call per writer, with a value its handler accepts. The field is where
 * the value must land; which machine it lands on is the field's owner.
 */
const WRITES: ReadonlyArray<{ channel: string; field: TerminalConfigField; value: unknown }> = [
  { channel: CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK, field: "scrollbackLines", value: 5000 },
  { channel: CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE, field: "performanceMode", value: true },
  { channel: CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE, field: "fontSize", value: 16 },
  { channel: CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY, field: "fontFamily", value: "Iosevka" },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED,
    field: "hybridInputEnabled",
    value: false,
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS,
    field: "hybridInputAutoFocus",
    value: true,
  },
  { channel: CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME, field: "colorSchemeId", value: "dracula" },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES,
    field: "customSchemes",
    value: [{ id: "mine", name: "Mine", type: "dark", builtin: false, colors: { bg: "#000" } }],
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS,
    field: "recentSchemeIds",
    value: ["dracula", "mine"],
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE,
    field: "screenReaderMode",
    value: "on",
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING,
    field: "resourceMonitoringEnabled",
    value: true,
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION,
    field: "memoryLeakDetectionEnabled",
    value: true,
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART,
    field: "memoryLeakAutoRestartThresholdMb",
    value: 4096,
  },
  {
    channel: CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS,
    field: "cachedProjectViews",
    value: 3,
  },
];

let forwarded: string[];
let cleanup: () => void;

/** The `ipcMain` listener a handler registered for local views. */
function localListener(channel: string): LocalListener {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as LocalListener;
}

/** A call from a window attached to the host, through the real dispatcher. */
async function invokeFromRemoteWindow(channel: string, args: unknown[]): Promise<IpcEnvelope> {
  const event = { sender: { id: REMOTE_SENDER } } as unknown as IpcMainInvokeEvent;
  return getIpcDispatcher().dispatchLocalInvoke(channel, event, args, localListener(channel));
}

beforeEach(() => {
  _resetIpcDispatcherForTesting();
  machines.shell.terminalConfig = {};
  machines.host.terminalConfig = {};
  machines.current = machines.shell;
  forwarded = [];
  const dispatcher = getIpcDispatcher();
  dispatcher.setInvokeEnveloper(async (_channel, _args, call, options) => {
    const value = await call();
    return options?.verbatim ? (value as IpcEnvelope) : wrapSuccess(value);
  });
  // The host runs the same handlers against its own store: a forwarded call
  // reaches its dispatcher as a link call from the window's endpoint.
  const invocation = {
    endpoint: { handle: 42, projectId: null },
    client: {},
  } as unknown as EndpointInvocation;
  const router: RemoteRouter = {
    hostForSender: (id) => (id === REMOTE_SENDER ? HOST : null),
    forwardInvoke: async (_hostId, _webContentsId, channel, args) => {
      forwarded.push(channel);
      machines.current = machines.host;
      try {
        return await dispatcher.invokeForEndpoint(invocation, channel, args);
      } finally {
        machines.current = machines.shell;
      }
    },
    forwardSend: vi.fn(),
  };
  dispatcher.setRemoteRouter(router);
  cleanup = registerTerminalConfigHandlers();
});

afterEach(() => {
  cleanup();
  _resetIpcDispatcherForTesting();
  vi.clearAllMocks();
});

describe("terminal config in a window attached to another host", () => {
  it("exercises a writer for every terminal-config setter and every field", () => {
    const setters = Object.values(CHANNELS).filter(
      (channel) =>
        channel.startsWith("terminal-config:") &&
        channel !== CHANNELS.TERMINAL_CONFIG_GET &&
        channel !== CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME
    );
    expect(WRITES.map((write) => write.channel).sort()).toEqual([...setters].sort());
    expect(new Set(WRITES.map((write) => write.field))).toEqual(
      new Set(Object.keys(TERMINAL_CONFIG_FIELD_OWNERSHIP))
    );
  });

  for (const { channel, field, value } of WRITES) {
    const owner = TERMINAL_CONFIG_FIELD_OWNERSHIP[field];
    it(`${channel} writes ${field} on the ${owner === "host" ? "host" : "machine you're at"}`, async () => {
      const envelope = await invokeFromRemoteWindow(channel, [value]);
      expect(envelope.ok, JSON.stringify(envelope)).toBe(true);

      const written = owner === "host" ? machines.host : machines.shell;
      const untouched = owner === "host" ? machines.shell : machines.host;
      // Exactly this field, with this value, on the owning machine; nothing on the other.
      expect(written.terminalConfig).toEqual({ [field]: value });
      expect(untouched.terminalConfig).toEqual({});
      expect(forwarded).toEqual(owner === "host" ? [channel] : []);
    });
  }

  it("imports a color scheme file from this machine without writing either store", async () => {
    const envelope = await invokeFromRemoteWindow(CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME, []);
    expect(envelope).toMatchObject({ ok: true, data: { ok: false } });
    expect(forwarded).toEqual([]);
    expect(machines.shell.terminalConfig).toEqual({});
    expect(machines.host.terminalConfig).toEqual({});
  });
});
