import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT_DICTATIONS, type RecentDictation } from "../../../../shared/types/voice.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

const views = vi.hoisted(() => ({
  list: [] as Array<{ isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: () => views.list,
}));

import { registerRecentDictationsHandlers } from "../recentDictations.js";
import { RECENT_DICTATIONS_METHOD_CHANNELS } from "../recentDictations.preload.js";

const sender = {
  sender: { id: 1, once: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false },
};

/** Call a channel and unwrap the `{ ok, data }` envelope; a refusal throws its error. */
async function call<T>(
  method: keyof typeof RECENT_DICTATIONS_METHOD_CHANNELS,
  ...args: unknown[]
): Promise<T> {
  const channel = RECENT_DICTATIONS_METHOD_CHANNELS[method];
  const entry = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  const result = (await (entry[1] as (...a: unknown[]) => Promise<unknown>)(sender, ...args)) as {
    ok?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (result && typeof result === "object" && "ok" in result) {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.data as T;
  }
  return result as T;
}

function dictation(id: string, overrides: Partial<RecentDictation> = {}): RecentDictation {
  return {
    id,
    rawText: `words of ${id}`,
    correctedText: null,
    target: { panelId: "panel-1", panelTitle: "Claude" },
    endedAt: 1,
    ...overrides,
  };
}

const list = () => call<RecentDictation[]>("list");

describe("recentDictations operations", () => {
  let cleanup: () => void = () => {};
  let view: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    view = { isDestroyed: () => false, send: vi.fn() };
    views.list = [view, { isDestroyed: () => true, send: vi.fn() }];
    cleanup = registerRecentDictationsHandlers();
  });

  afterEach(() => cleanup());

  it("keeps the newest sessions first and drops the oldest past the cap", async () => {
    for (let i = 1; i <= MAX_RECENT_DICTATIONS + 2; i++) await call("record", dictation(`s${i}`));

    const ids = (await list()).map((d) => d.id);
    expect(ids).toHaveLength(MAX_RECENT_DICTATIONS);
    expect(ids[0]).toBe(`s${MAX_RECENT_DICTATIONS + 2}`);
    expect(ids).not.toContain("s1");
    expect(ids).not.toContain("s2");
  });

  it("updates a session recorded again in place, keeping a cleanup it already has", async () => {
    await call("record", dictation("a"));
    await call("record", dictation("b"));
    await call("setCorrectedText", { id: "a", correctedText: "Cleaned." });
    await call("record", dictation("a", { rawText: "more words" }));

    const entries = await list();
    expect(entries.map((d) => d.id)).toEqual(["b", "a"]);
    expect(entries[1]).toMatchObject({ rawText: "more words", correctedText: "Cleaned." });
  });

  it("keeps a cleanup that changed the words, and none that changed only spacing", async () => {
    await call("record", dictation("a", { rawText: "helo wrld" }));
    await call("record", dictation("b", { rawText: "one\ntwo" }));
    await call("setCorrectedText", { id: "a", correctedText: "Hello world." });
    await call("setCorrectedText", { id: "b", correctedText: "one two" });
    await call("setCorrectedText", { id: "gone", correctedText: "Anything." });

    const byId = new Map((await list()).map((d) => [d.id, d]));
    expect(byId.get("a")?.correctedText).toBe("Hello world.");
    expect(byId.get("b")?.correctedText).toBeNull();
    expect(byId.has("gone")).toBe(false);
  });

  it("tells every live view to re-read, with no text on the signal", async () => {
    await call("record", dictation("a"));
    await call("setCorrectedText", { id: "a", correctedText: "Changed." });
    // Nothing changed, so nobody needs to re-read.
    await call("setCorrectedText", { id: "a", correctedText: "Changed." });

    expect(view.send).toHaveBeenCalledTimes(2);
    for (const args of view.send.mock.calls) expect(args).toEqual(["recent-dictations:changed"]);
  });

  it("refuses a malformed entry without echoing or logging what was dictated", async () => {
    const secret = "the launch code is swordfish";
    const sinks = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );
    let message = "";
    try {
      await call("record", { ...dictation("a", { rawText: secret }), endedAt: "soon" });
    } catch (error) {
      message = String(error);
    }

    expect(message).not.toBe("");
    expect(message).not.toContain("swordfish");
    // Nothing is logged at all: a log line is where dictated text would leak,
    // and an Error argument wouldn't show up in a serialized check.
    for (const sink of sinks) {
      expect(sink).not.toHaveBeenCalled();
      sink.mockRestore();
    }
    expect(await list()).toEqual([]);
  });

  it("forgets everything when its handlers are torn down", async () => {
    await call("record", dictation("a"));
    cleanup();
    cleanup = registerRecentDictationsHandlers();

    expect(await list()).toEqual([]);
  });
});
