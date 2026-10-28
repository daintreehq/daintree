import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focusedId: null as string | null,
  holding: null as "hybridInput" | "xterm" | null,
  requestPaneFocus: vi.fn(),
}));

vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ focusedId: mocks.focusedId }) },
}));
vi.mock("@/store/storeAccessors", () => ({ exitProjectHome: vi.fn() }));
vi.mock("@/services/terminal/terminalInstanceServiceAccessor", () => ({ peek: vi.fn() }));
vi.mock("@/components/Terminal/paneFocusRequest", () => ({
  paneSurfaceHoldingFocus: () => mocks.holding,
  requestPaneFocus: mocks.requestPaneFocus,
}));

const { registerTerminalNavigationActions } = await import("../terminalNavigationActions");

async function run(): Promise<void> {
  const actions = new Map<string, () => { run: (args: unknown, ctx: unknown) => Promise<void> }>();
  registerTerminalNavigationActions(actions as never, {} as never);
  await actions.get("terminal.toggleInputSurface")!().run(undefined, {});
}

describe("terminal.toggleInputSurface", () => {
  beforeEach(() => {
    mocks.focusedId = "p1";
    mocks.holding = null;
    mocks.requestPaneFocus.mockClear();
  });

  it("moves from the hybrid input to the terminal", async () => {
    mocks.holding = "hybridInput";
    await run();
    expect(mocks.requestPaneFocus).toHaveBeenCalledWith("p1", "xterm");
  });

  it("moves from the terminal to the hybrid input", async () => {
    mocks.holding = "xterm";
    await run();
    expect(mocks.requestPaneFocus).toHaveBeenCalledWith("p1", "hybridInput");
  });

  it("asks for the hybrid input when neither surface holds the keyboard", async () => {
    await run();
    expect(mocks.requestPaneFocus).toHaveBeenCalledWith("p1", "hybridInput");
  });

  it("does nothing without a focused pane", async () => {
    mocks.focusedId = null;
    await run();
    expect(mocks.requestPaneFocus).not.toHaveBeenCalled();
  });
});
