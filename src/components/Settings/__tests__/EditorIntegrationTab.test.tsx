// @vitest-environment jsdom
/**
 * EditorIntegrationTab — the Test button has to exercise the preference it
 * sits next to (#12327). Without a project id the main process never loads
 * `preferredEditor` and silently launches whatever discovery finds first, so
 * the button reported success for an editor the user had not chosen.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const { getConfigMock, setConfigMock, discoverMock, openInEditorMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  setConfigMock: vi.fn().mockResolvedValue(undefined),
  discoverMock: vi.fn().mockResolvedValue([]),
  openInEditorMock: vi.fn(),
}));

vi.mock("@/clients/editorClient", () => ({
  editorClient: { getConfig: getConfigMock, setConfig: setConfigMock, discover: discoverMock },
}));

vi.mock("@/utils/logger", () => ({ logError: vi.fn(), logDebug: vi.fn() }));

// Radix tooltip machinery is irrelevant here and lazy-loads its primitives.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

const PROJECT = { id: "proj-42", path: "/repos/daintree" };

vi.mock("@/store", () => ({
  useProjectStore: (selector: (state: { currentProject: typeof PROJECT }) => unknown) =>
    selector({ currentProject: PROJECT }),
}));

import { EditorIntegrationTab } from "../EditorIntegrationTab";

describe("EditorIntegrationTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue({
      preferredEditor: { id: "custom", customCommand: "mine", customTemplate: "{file}" },
      discoveredEditors: [],
    });
    discoverMock.mockResolvedValue([]);
    openInEditorMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      value: { system: { openInEditor: openInEditorMock } },
      writable: true,
      configurable: true,
    });
  });

  async function renderTab() {
    render(<EditorIntegrationTab />);
    await waitFor(() => expect(getConfigMock).toHaveBeenCalledWith(PROJECT.id));
    return screen.getByRole("button", { name: "Test" });
  }

  it("sends the active project id so the saved preference is the thing under test", async () => {
    const testButton = await renderTab();

    fireEvent.click(testButton);

    await waitFor(() => expect(openInEditorMock).toHaveBeenCalledTimes(1));
    expect(openInEditorMock).toHaveBeenCalledWith({
      path: PROJECT.path,
      projectId: PROJECT.id,
    });
  });

  it("reports the launch only once the main process answers, and claims no more than it saw", async () => {
    let settle!: () => void;
    openInEditorMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );

    const testButton = await renderTab();
    fireEvent.click(testButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Testing…" })).toBeDefined());
    expect(screen.queryByText("Open requested")).toBeNull();

    await act(async () => {
      settle();
    });

    // All this path verifies is that the request was handled. The chain can
    // end in a fallback editor, or in shell.openPath, so naming an editor
    // would claim more than was observed.
    await waitFor(() => expect(screen.getByText("Open requested")).toBeDefined());
  });

  it("surfaces a failed launch instead of a success message", async () => {
    openInEditorMock.mockRejectedValue(new Error("no such binary"));

    const testButton = await renderTab();
    fireEvent.click(testButton);

    await waitFor(() => expect(screen.getByText("Failed to open")).toBeDefined());
    expect(screen.queryByText("Open requested")).toBeNull();
  });
});
