// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { VoiceRecordingToolbarButton } from "../VoiceRecordingToolbarButton";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

const focusActiveTarget = vi.fn();
let mockCombo: string | undefined;

vi.mock("@/services/VoiceRecordingService", () => ({
  voiceRecordingService: { focusActiveTarget: () => focusActiveTarget() },
}));

vi.mock("@/hooks", () => ({
  useAriaKeyshortcuts: () => "Meta+.",
  useEffectiveCombo: () => mockCombo,
  useShortcutHintHover: () => ({}),
}));

vi.mock("@/hooks/useDeferredLoading", () => ({
  useDohertyGate: (value: boolean) => value,
}));

vi.mock("@/lib/appThemeViewTransition", () => ({
  prefersReducedMotion: () => true,
}));

vi.mock("../ToolbarContextMenuItems", () => ({
  ToolbarContextMenuItems: () => null,
}));

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock("@/lib/tooltipShortcut", () => ({
  createTooltipContent: (label: React.ReactNode, shortcut?: string) => (
    <span data-testid="tooltip-shortcut-row" data-shortcut={shortcut ?? ""}>
      {label}
    </span>
  ),
}));

describe("VoiceRecordingToolbarButton — tooltip names what a click does", () => {
  beforeEach(() => {
    focusActiveTarget.mockClear();
    mockCombo = undefined;
  });

  function renderWith(status: "recording" | "paused") {
    useVoiceRecordingStore.setState({
      isConfigured: true,
      status,
      elapsedSeconds: 42,
      activeTarget: {
        panelId: "p-1",
        panelTitle: "claude · notes",
        projectName: "Daintree",
        worktreeLabel: "main",
      },
    });
    return render(<VoiceRecordingToolbarButton />);
  }

  it.each([
    { status: "recording" as const, combo: undefined },
    { status: "recording" as const, combo: "Cmd+." },
    { status: "paused" as const, combo: undefined },
    { status: "paused" as const, combo: "Ctrl+Shift+Space" },
  ])("states the click action ($status, combo $combo)", ({ status, combo }) => {
    mockCombo = combo;
    const { getByTestId, container } = renderWith(status);

    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(focusActiveTarget).toHaveBeenCalledTimes(1);
    // Clicking jumps to the panel; the dictation shortcuts stop or resume
    // recording instead, so neither may be advertised as this button's own.
    expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);

    // Whatever else it says, the tooltip must describe the click the user is
    // about to make, and a bound shortcut stays a separate keyed row.
    expect(getByTestId("tooltip-content").textContent).toMatch(/click to jump to panel/i);
    const shortcutRow = container.querySelector('[data-testid="tooltip-shortcut-row"]');
    if (combo) {
      expect(shortcutRow?.getAttribute("data-shortcut")).toBe(combo);
      expect(shortcutRow?.textContent).not.toMatch(/click/i);
    } else {
      expect(shortcutRow).toBeNull();
    }
  });
});
