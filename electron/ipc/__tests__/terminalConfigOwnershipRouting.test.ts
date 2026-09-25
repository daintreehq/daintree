import { describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "../../../shared/utils/ipcErrorSerialization.js";
import type { IpcEnvelope } from "../../../shared/types/ipc/errors.js";
import type { StoreSchema } from "../../store.js";
import { TERMINAL_CONFIG_FIELD_OWNERSHIP } from "../../storeOwnership.js";
import { getChannelLocality } from "../channelLocality.js";
import { CHANNELS } from "../channels.js";
import { IpcDispatcherImpl } from "../dispatcher.js";
import type { RemoteRouter } from "../endpoint.js";

type TerminalConfigField = keyof StoreSchema["terminalConfig"];

/** The field each terminal-config writer changes. */
const WRITER_FIELD: Record<string, TerminalConfigField> = {
  [CHANNELS.TERMINAL_CONFIG_SET_SCROLLBACK]: "scrollbackLines",
  [CHANNELS.TERMINAL_CONFIG_SET_PERFORMANCE_MODE]: "performanceMode",
  [CHANNELS.TERMINAL_CONFIG_SET_FONT_SIZE]: "fontSize",
  [CHANNELS.TERMINAL_CONFIG_SET_FONT_FAMILY]: "fontFamily",
  [CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_ENABLED]: "hybridInputEnabled",
  [CHANNELS.TERMINAL_CONFIG_SET_HYBRID_INPUT_AUTO_FOCUS]: "hybridInputAutoFocus",
  [CHANNELS.TERMINAL_CONFIG_SET_COLOR_SCHEME]: "colorSchemeId",
  [CHANNELS.TERMINAL_CONFIG_SET_CUSTOM_SCHEMES]: "customSchemes",
  [CHANNELS.TERMINAL_CONFIG_SET_RECENT_SCHEME_IDS]: "recentSchemeIds",
  [CHANNELS.TERMINAL_CONFIG_IMPORT_COLOR_SCHEME]: "customSchemes",
  [CHANNELS.TERMINAL_CONFIG_SET_SCREEN_READER_MODE]: "screenReaderMode",
  [CHANNELS.TERMINAL_CONFIG_SET_RESOURCE_MONITORING]: "resourceMonitoringEnabled",
  [CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_DETECTION]: "memoryLeakDetectionEnabled",
  [CHANNELS.TERMINAL_CONFIG_SET_MEMORY_LEAK_AUTO_RESTART]: "memoryLeakAutoRestartThresholdMb",
  [CHANNELS.TERMINAL_CONFIG_SET_CACHED_PROJECT_VIEWS]: "cachedProjectViews",
};

const REMOTE_SENDER = 5;

function remoteWindow() {
  const dispatcher = new IpcDispatcherImpl();
  dispatcher.setInvokeEnveloper(async (_channel, _args, call, options) => {
    const value = await call();
    return options?.verbatim ? (value as IpcEnvelope) : wrapSuccess(value);
  });
  const forwardInvoke = vi.fn(async () => wrapSuccess("host"));
  const router: RemoteRouter = {
    hostForSender: (id) => (id === REMOTE_SENDER ? "studio" : null),
    forwardInvoke,
    forwardSend: vi.fn(),
  };
  dispatcher.setRemoteRouter(router);
  const listener = vi.fn(async () => "device");
  const invoke = async (channel: string) => {
    const envelope = await dispatcher.dispatchLocalInvoke(
      channel,
      { sender: { id: REMOTE_SENDER } } as never,
      [1],
      listener as never
    );
    return envelope.ok ? envelope.data : envelope.error;
  };
  return { invoke, forwardInvoke, listener };
}

describe("terminal config in a window attached to another host", () => {
  it("names a writer for every terminal-config channel and every field", () => {
    const channels = Object.values(CHANNELS).filter(
      (channel) =>
        channel.startsWith("terminal-config:") && channel !== CHANNELS.TERMINAL_CONFIG_GET
    );
    expect(Object.keys(WRITER_FIELD).sort()).toEqual([...channels].sort());
    const written = new Set(Object.values(WRITER_FIELD));
    for (const field of Object.keys(TERMINAL_CONFIG_FIELD_OWNERSHIP)) {
      expect(written.has(field as TerminalConfigField), field).toBe(true);
    }
  });

  it("classifies each writer with the owner of the field it writes", () => {
    for (const [channel, field] of Object.entries(WRITER_FIELD)) {
      const owner = TERMINAL_CONFIG_FIELD_OWNERSHIP[field];
      expect(getChannelLocality(channel), `${channel} writes ${field}`).toBe(
        owner === "device" ? "shell" : "host"
      );
    }
  });

  it("writes behaviour on the host and appearance on this machine", async () => {
    for (const [channel, field] of Object.entries(WRITER_FIELD)) {
      const { invoke, forwardInvoke, listener } = remoteWindow();
      const answer = await invoke(channel);
      if (TERMINAL_CONFIG_FIELD_OWNERSHIP[field] === "host") {
        expect(answer, channel).toBe("host");
        expect(forwardInvoke).toHaveBeenCalledWith("studio", REMOTE_SENDER, channel, [1]);
        expect(listener).not.toHaveBeenCalled();
      } else {
        expect(answer, channel).toBe("device");
        expect(forwardInvoke).not.toHaveBeenCalled();
      }
    }
  });
});
