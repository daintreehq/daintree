/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConsolePanel, serializeConsoleMessage, serializeConsoleMessages } from "../ConsolePanel";
import {
  useConsoleCaptureStore,
  flushConsoleCaptureBuffer,
  type ConsoleMessage,
} from "@/store/consoleCaptureStore";
import type { SerializedConsoleRow } from "@shared/types/ipc/webviewConsole";

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => (
    <div data-testid="virtuoso">
      {data.map((item, i) => (
        <div key={i}>{itemContent(i, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockPaneId = "test-pane-id";

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);

let nextId = 1;

function seedConsoleRow(overrides: Partial<SerializedConsoleRow> = {}): void {
  const level = overrides.level ?? "log";
  const row: SerializedConsoleRow = {
    id: nextId++,
    paneId: mockPaneId,
    level,
    cdpType: level,
    args: [],
    summaryText: "boom",
    timestamp: Date.now(),
    navigationGeneration: 0,
    groupDepth: 0,
    ...overrides,
  };
  useConsoleCaptureStore.getState().addStructuredMessage(row);
  flushConsoleCaptureBuffer();
}

function makeMessage(overrides: Partial<ConsoleMessage> = {}): ConsoleMessage {
  return {
    id: 1,
    paneId: mockPaneId,
    level: "error",
    cdpType: "error",
    args: [],
    summaryText: "boom",
    timestamp: 0,
    navigationGeneration: 0,
    groupDepth: 0,
    isStale: false,
    timeLabel: "12:34:56.789",
    isGroupHeader: false,
    ...overrides,
  };
}

function renderPanel() {
  return render(<ConsolePanel paneId={mockPaneId} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 1;
  useConsoleCaptureStore.setState({ messages: new Map(), counters: new Map() });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serializeConsoleMessage", () => {
  it("formats a row as [time] [level] summary", () => {
    expect(serializeConsoleMessage(makeMessage())).toBe("[12:34:56.789] [ERR] boom");
  });

  it("uses the level badge labels", () => {
    expect(serializeConsoleMessage(makeMessage({ level: "warning" }))).toContain("[WRN]");
    expect(serializeConsoleMessage(makeMessage({ level: "info" }))).toContain("[INF]");
    expect(serializeConsoleMessage(makeMessage({ level: "log" }))).toContain("[LOG]");
  });

  it("appends stack frames in Chrome's text format", () => {
    const msg = makeMessage({
      stackTrace: {
        callFrames: [
          { functionName: "doThing", url: "http://x/app.js", lineNumber: 10, columnNumber: 5 },
          { functionName: "", url: "", lineNumber: 0, columnNumber: 0 },
        ],
      },
    });
    expect(serializeConsoleMessage(msg)).toBe(
      "[12:34:56.789] [ERR] boom\n  at doThing (http://x/app.js:10:5)\n  at (anonymous)"
    );
  });

  it("strips control and Bidi characters but keeps line structure", () => {
    const msg = makeMessage({
      summaryText: "safe\u001b[31m\u202etext\nsecond",
      stackTrace: {
        callFrames: [{ functionName: "fn", url: "http://x/a.js", lineNumber: 1, columnNumber: 2 }],
      },
    });
    const out = serializeConsoleMessage(msg);
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u202e");
    // Multi-line summaries keep their line structure (matching the
    // whitespace-pre-wrap display); other controls are stripped per line.
    expect(out.split("\n")).toEqual([
      "[12:34:56.789] [ERR] safe[31mtext",
      "second",
      "  at fn (http://x/a.js:1:2)",
    ]);
  });

  it("preserves multi-line exception text without a stack trace", () => {
    const msg = makeMessage({ summaryText: "TypeError: x\n  at foo (app.js:1:1)" });
    expect(serializeConsoleMessage(msg)).toBe(
      "[12:34:56.789] [ERR] TypeError: x\n  at foo (app.js:1:1)"
    );
  });

  it("joins multiple messages with newlines", () => {
    const out = serializeConsoleMessages([
      makeMessage({ summaryText: "first" }),
      makeMessage({ summaryText: "second", level: "log" }),
    ]);
    expect(out).toBe("[12:34:56.789] [ERR] first\n[12:34:56.789] [LOG] second");
  });
});

describe("per-row copy", () => {
  it("copies the serialized row text on click", () => {
    seedConsoleRow({ level: "error", summaryText: "row text" });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Copy console message" }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[ERR\] row text$/)
    );
  });

  it("includes stack frames in the copied text", () => {
    seedConsoleRow({
      level: "error",
      summaryText: "with stack",
      stackTrace: {
        callFrames: [
          { functionName: "handler", url: "http://x/main.js", lineNumber: 3, columnNumber: 7 },
        ],
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Copy console message" }));

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("with stack\n  at handler (http://x/main.js:3:7)")
    );
  });

  it("copies the clicked row, not another row", () => {
    seedConsoleRow({ summaryText: "first row" });
    seedConsoleRow({ summaryText: "second row" });
    seedConsoleRow({ summaryText: "third row" });
    renderPanel();

    fireEvent.click(screen.getAllByRole("button", { name: "Copy console message" })[1]!);

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("second row");
    expect(text).not.toContain("first row");
    expect(text).not.toContain("third row");
  });

  it("shows the copied check after a successful copy", async () => {
    seedConsoleRow({ summaryText: "feedback" });
    renderPanel();

    const button = screen.getByRole("button", { name: "Copy console message" });
    fireEvent.click(button);

    await waitFor(() => expect(button.querySelector(".animate-badge-bump")).toBeTruthy());
  });

  it("does not show the copied check when the clipboard write fails", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    seedConsoleRow({ summaryText: "rejected" });
    renderPanel();

    const button = screen.getByRole("button", { name: "Copy console message" });
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(button.querySelector(".animate-badge-bump")).toBeNull();
  });
});

describe("toolbar copy visible", () => {
  const getCopyVisibleButton = () =>
    screen.getByRole("button", { name: "Copy visible console messages" });

  it("is disabled when there are no visible messages", () => {
    renderPanel();
    expect(getCopyVisibleButton().hasAttribute("disabled")).toBe(true);
  });

  it("copies all visible messages in order", () => {
    seedConsoleRow({ summaryText: "one" });
    seedConsoleRow({ summaryText: "two" });
    seedConsoleRow({ summaryText: "three" });
    renderPanel();

    fireEvent.click(getCopyVisibleButton());

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0];
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("one");
    expect(lines[1]).toContain("two");
    expect(lines[2]).toContain("three");
  });

  it("respects the active level filter", () => {
    seedConsoleRow({ level: "error", summaryText: "bad" });
    seedConsoleRow({ level: "log", summaryText: "fine" });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /errors/i }));
    fireEvent.click(getCopyVisibleButton());

    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("bad");
    expect(text).not.toContain("fine");
  });

  it("respects the search filter", () => {
    seedConsoleRow({ summaryText: "alpha event" });
    seedConsoleRow({ summaryText: "beta event" });
    renderPanel();

    fireEvent.change(screen.getByLabelText("Filter console messages"), {
      target: { value: "alpha" },
    });
    fireEvent.click(getCopyVisibleButton());

    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("alpha event");
    expect(text).not.toContain("beta event");
  });

  it("excludes children of collapsed groups", () => {
    seedConsoleRow({ cdpType: "startGroupCollapsed", summaryText: "group header" });
    seedConsoleRow({ summaryText: "hidden child", groupDepth: 1 });
    renderPanel();

    fireEvent.click(getCopyVisibleButton());

    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("group header");
    expect(text).not.toContain("hidden child");
  });

  it("excludes the whole nested subtree of a collapsed group but keeps siblings", () => {
    seedConsoleRow({ cdpType: "startGroupCollapsed", summaryText: "outer group" });
    seedConsoleRow({ cdpType: "startGroup", summaryText: "inner group", groupDepth: 1 });
    seedConsoleRow({ summaryText: "grandchild", groupDepth: 2 });
    seedConsoleRow({ summaryText: "sibling after" });
    renderPanel();

    fireEvent.click(getCopyVisibleButton());

    const text = writeText.mock.calls[0]![0];
    expect(text).toContain("outer group");
    expect(text).toContain("sibling after");
    expect(text).not.toContain("inner group");
    expect(text).not.toContain("grandchild");
  });

  it("is disabled and copies nothing when the filter matches no rows", () => {
    seedConsoleRow({ level: "error", summaryText: "only an error" });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Warn" }));

    const button = getCopyVisibleButton();
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("accessibility", () => {
  it("labels the filter input", () => {
    renderPanel();
    const input = screen.getByLabelText("Filter console messages");
    expect(input.tagName).toBe("INPUT");
  });

  it("exposes expand state on the group toggle", () => {
    seedConsoleRow({ cdpType: "startGroupCollapsed", summaryText: "group header" });
    renderPanel();

    const toggle = screen.getByRole("button", { name: "Toggle console group" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    const expanded = screen.getByRole("button", { name: "Toggle console group" });
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the row copy button label constant after copying", () => {
    seedConsoleRow({ summaryText: "stable label" });
    renderPanel();

    const button = screen.getByRole("button", { name: "Copy console message" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Copy console message" })).toBeTruthy();
  });
});
