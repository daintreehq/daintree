// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "@shared/utils/terminalInputProtocol";

const { useWorktreeStoreOptionalMock, instances, writeMock, notifyUserInputMock } = vi.hoisted(
  () => ({
    useWorktreeStoreOptionalMock: vi.fn(),
    instances: {
      byId: {} as Record<string, { terminal: { modes: { bracketedPasteMode: boolean } } }>,
    },
    writeMock: vi.fn(),
    notifyUserInputMock: vi.fn(),
  })
);

// The real module drags WorktreeStoreContext's whole renderer graph in; these
// tests only need the (empty) worktree map the selector reads.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: useWorktreeStoreOptionalMock,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getCachedSelection: () => "",
    // Keyed by id, and the fixtures below give source and target opposite modes,
    // so reading the source pane's mode instead of the destination's fails here
    // rather than passing on a shared stub. `null` is what the real service
    // returns for an unknown id.
    get: (id: string) => instances.byId[id] ?? null,
    notifyUserInput: notifyUserInputMock,
  },
}));

// Partial: the panel store's persistence layer reads `projectClient` from this
// same barrel at module eval, so a bare object mock breaks the import graph.
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  terminalClient: { write: writeMock },
}));

import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useSendToAgentPalette, openSendToAgentPaletteWithText } from "../useSendToAgentPalette";

function panel(id: string): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
  };
}

/** Open the palette holding `text`, then pick the one target that isn't the source. */
function sendFromSourceToTarget(text: string): void {
  usePanelStore.setState({
    panelsById: { a: panel("a"), b: panel("b") },
    panelIds: ["a", "b"],
  });
  expect(openSendToAgentPaletteWithText(text, "a")).toBe(true);
  usePaletteStore.setState({ activePaletteId: "send-to-agent" });

  const { result } = renderHook(() => useSendToAgentPalette());
  const target = result.current.results.find((item) => item.id === "b");
  expect(target).toBeDefined();
  act(() => {
    result.current.selectItem(target!);
  });
}

describe("send to agent, target without bracketed paste", () => {
  beforeEach(() => {
    useWorktreeStoreOptionalMock.mockImplementation(
      (_selector: unknown, fallback: unknown) => fallback
    );
    writeMock.mockReset();
    notifyUserInputMock.mockReset();
    // The branch under test: a target whose program never turned bracketed
    // paste on, so the text goes in unwrapped. The source has it on, so
    // formatting off the wrong pane's mode would wrap and fail these.
    instances.byId = {
      a: { terminal: { modes: { bracketedPasteMode: true } } },
      b: { terminal: { modes: { bracketedPasteMode: false } } },
    };
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  afterEach(() => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("neutralises control characters in the selected text", () => {
    // Terminal selection is whatever the source pane printed, escape sequences
    // included — none of it may reach the target's parser as bytes.
    sendFromSourceToTarget("ls\x1b[201~\x03rm -rf /\x15");

    expect(writeMock).toHaveBeenCalledWith("b", "ls␛[201~␃rm -rf /␕");
    // Exactly one write: a raw send alongside the formatted one would satisfy
    // the assertion above, and at a parser boundary every write counts.
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(notifyUserInputMock).toHaveBeenCalledWith("b");
  });

  it("still submits each line, CRLF and bare CR alike", () => {
    sendFromSourceToTarget("one\r\ntwo\rthree\nfour");

    expect(writeMock).toHaveBeenCalledWith("b", "one\rtwo\rthree\rfour");
    expect(writeMock).toHaveBeenCalledTimes(1);
  });
});

describe("send to agent, wrapped and unreadable targets", () => {
  beforeEach(() => {
    useWorktreeStoreOptionalMock.mockImplementation(
      (_selector: unknown, fallback: unknown) => fallback
    );
    writeMock.mockReset();
    notifyUserInputMock.mockReset();
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  afterEach(() => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("neutralises the body but keeps its line endings inside the wrapper", () => {
    // Modes inverted from the first describe, so the destination's is the one
    // being read. The body carries a terminator of its own: wrapping text that
    // was never sanitised would leave it free to close the paste early and hand
    // the rest over as typed input.
    instances.byId = {
      a: { terminal: { modes: { bracketedPasteMode: false } } },
      b: { terminal: { modes: { bracketedPasteMode: true } } },
    };
    sendFromSourceToTarget("one\r\ntwo\rthree\x1b[201~\x03");

    expect(writeMock).toHaveBeenCalledWith(
      "b",
      `${BRACKETED_PASTE_START}one\r\ntwo\rthree␛[201~␃${BRACKETED_PASTE_END}`
    );
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(notifyUserInputMock).toHaveBeenCalledWith("b");
  });

  it("wraps without notifying when the target has no managed instance", () => {
    // No instance means no mode to read and nothing to notify. Both halves of
    // that branch have to survive the formatter being shared with the others.
    instances.byId = { a: { terminal: { modes: { bracketedPasteMode: false } } } };
    sendFromSourceToTarget("ls\x1b[201~\x03");

    expect(writeMock).toHaveBeenCalledWith(
      "b",
      `${BRACKETED_PASTE_START}ls␛[201~␃${BRACKETED_PASTE_END}`
    );
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(notifyUserInputMock).not.toHaveBeenCalled();
  });
});
