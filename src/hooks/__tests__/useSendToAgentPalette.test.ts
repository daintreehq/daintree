import { describe, it, expect, vi, beforeEach } from "vitest";

const getCachedSelection = vi.fn<(id: string) => string>();
const openPalette = vi.fn<(id: string) => void>();

let panelState: {
  panelIds: string[];
  panelsById: Record<string, { id: string; location?: string; kind?: string; hasPty?: boolean }>;
} = { panelIds: [], panelsById: {} };

vi.mock("@/store", () => ({
  usePanelStore: { getState: () => panelState },
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ openPalette }) },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getCachedSelection: (id: string) => getCachedSelection(id),
    get: () => undefined,
  },
}));

vi.mock("@/clients", () => ({ terminalClient: { write: vi.fn() } }));
vi.mock("@shared/utils/terminalInputProtocol", () => ({
  formatWithBracketedPaste: (t: string) => t,
}));
vi.mock("@shared/config/panelKindRegistry", () => ({ panelKindHasPty: () => true }));
vi.mock("@/utils/terminalChrome", () => ({ deriveTerminalChrome: () => ({ label: "" }) }));
vi.mock("./useSearchablePalette", () => ({ useSearchablePalette: () => ({}) }));

import { openSendToAgentPalette, openSendToAgentPaletteWithText } from "../useSendToAgentPalette";

beforeEach(() => {
  getCachedSelection.mockReset();
  openPalette.mockReset();
  panelState = {
    panelIds: ["a", "b"],
    panelsById: {
      a: { id: "a" },
      b: { id: "b" },
    },
  };
});

describe("openSendToAgentPaletteWithText", () => {
  it("returns false and does not open the palette for empty text", () => {
    expect(openSendToAgentPaletteWithText("")).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
  });

  it("returns false for whitespace-only text", () => {
    expect(openSendToAgentPaletteWithText("   \n\t ", "a")).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
  });

  it("returns false when there are no eligible targets", () => {
    panelState = { panelIds: ["a"], panelsById: { a: { id: "a" } } };
    expect(openSendToAgentPaletteWithText("hello", "a")).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();
  });

  it("opens the send-to-agent palette with arbitrary text when targets exist", () => {
    expect(openSendToAgentPaletteWithText("hello", "a")).toBe(true);
    expect(openPalette).toHaveBeenCalledWith("send-to-agent");
  });

  it("does not require a cached terminal selection", () => {
    getCachedSelection.mockReturnValue("");
    expect(openSendToAgentPaletteWithText("from-banner")).toBe(true);
    expect(getCachedSelection).not.toHaveBeenCalled();
    expect(openPalette).toHaveBeenCalledWith("send-to-agent");
  });
});

describe("openSendToAgentPalette (regression)", () => {
  it("still gates on the cached selection", () => {
    getCachedSelection.mockReturnValue("");
    expect(openSendToAgentPalette("a")).toBe(false);
    expect(openPalette).not.toHaveBeenCalled();

    getCachedSelection.mockReturnValue("selected text");
    expect(openSendToAgentPalette("a")).toBe(true);
    expect(openPalette).toHaveBeenCalledWith("send-to-agent");
  });
});
