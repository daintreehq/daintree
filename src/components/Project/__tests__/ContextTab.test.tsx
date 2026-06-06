/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { CopyTreeSettings, CopyTreeTestConfigResult, Worktree } from "@/types";

const { testConfigMock } = vi.hoisted(() => ({ testConfigMock: vi.fn() }));

vi.mock("@/clients/copyTreeClient", () => ({
  copyTreeClient: { testConfig: testConfigMock },
}));

import { ContextTab } from "../ContextTab";

const mainWorktree = { id: "wt-1", isMainWorktree: true } as unknown as Worktree;

function renderTab(overrides: Partial<React.ComponentProps<typeof ContextTab>> = {}) {
  const props: React.ComponentProps<typeof ContextTab> = {
    excludedPaths: [],
    onExcludedPathsChange: vi.fn(),
    copyTreeSettings: {} as CopyTreeSettings,
    onCopyTreeSettingsChange: vi.fn(),
    worktrees: [mainWorktree],
    isOpen: true,
    ...overrides,
  };
  return render(<ContextTab {...props} />);
}

const successResult: CopyTreeTestConfigResult = {
  includedFiles: 5,
  includedSize: 2048,
  excluded: { byTruncation: 1, bySize: 2, byPattern: 3 },
};

beforeEach(() => {
  testConfigMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ContextTab copy", () => {
  it("renders headings and labels in sentence case, not Title Case", () => {
    renderTab();

    // Sentence-case headings/labels present (getByText throws if absent)
    expect(screen.getByText("Excluded paths")).toBeTruthy();
    expect(screen.getByText("Context generation settings")).toBeTruthy();
    expect(screen.getByText("Test configuration")).toBeTruthy();
    expect(screen.getByText("Max context size (bytes)")).toBeTruthy();
    expect(screen.getByText("Max file size (bytes)")).toBeTruthy();
    expect(screen.getByText("Char limit (per file)")).toBeTruthy();
    expect(screen.getByText("File priority strategy")).toBeTruthy();
    expect(screen.getByText("Always include (glob patterns)")).toBeTruthy();
    expect(screen.getByText("Always exclude (glob patterns)")).toBeTruthy();

    // Former Title Case variants are gone
    expect(screen.queryByText("Excluded Paths")).toBeNull();
    expect(screen.queryByText("Test Configuration")).toBeNull();
    expect(screen.queryByText("Max Context Size (bytes)")).toBeNull();
  });

  it("uses sentence-case button labels", () => {
    renderTab();
    expect(screen.getByRole("button", { name: /add path pattern/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add include pattern/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add exclude pattern/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test config" })).toBeTruthy();
  });

  it("drops trailing periods on single-sentence subtitles but keeps them on multi-sentence", () => {
    renderTab();

    const excludedSubtitle = screen
      .getByText(/Glob patterns to exclude from monitoring and context injection/)
      .textContent?.trim();
    expect(excludedSubtitle?.endsWith(")")).toBe(true);
    expect(excludedSubtitle?.endsWith(").")).toBe(false);

    const includeSubtitle = screen
      .getByText(/Files matching these patterns will always be included/)
      .textContent?.trim();
    expect(includeSubtitle?.endsWith("excluded")).toBe(true);

    const excludeSubtitle = screen
      .getByText(/Additional exclusion patterns beyond the default excluded paths above/)
      .textContent?.trim();
    expect(excludeSubtitle?.endsWith("above")).toBe(true);

    // Two-sentence subtitle keeps both periods
    const multiSentence = screen
      .getByText(/Configure how CopyTree generates context for AI agents/)
      .textContent?.trim();
    expect(multiSentence?.endsWith("copying to clipboard.")).toBe(true);
  });
});

describe("ContextTab test-config button", () => {
  it("disables the button when there are no worktrees", () => {
    renderTab({ worktrees: [] });
    const button = screen.getByRole("button", { name: "Test config" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("marks the button busy via the shared loading prop while the dry-run is pending", async () => {
    testConfigMock.mockReturnValue(new Promise<CopyTreeTestConfigResult>(() => {}));
    renderTab();

    const button = screen.getByRole("button", { name: "Test config" });
    expect(button.getAttribute("aria-busy")).not.toBe("true");

    await act(async () => {
      fireEvent.click(button);
    });

    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("clears aria-busy after the dry-run resolves successfully", async () => {
    testConfigMock.mockResolvedValue(successResult);
    renderTab();

    const button = screen.getByRole("button", { name: "Test config" });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(screen.getByText("5 files would be included")).toBeTruthy();
    });
    expect(button.getAttribute("aria-busy")).not.toBe("true");
  });

  it("clears aria-busy after the dry-run fails", async () => {
    testConfigMock.mockRejectedValue(new Error("nope"));
    renderTab();

    const button = screen.getByRole("button", { name: "Test config" });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => {
      expect(button.getAttribute("aria-busy")).not.toBe("true");
    });
  });

  it("shows the deferred skeleton only after the gate threshold while pending", async () => {
    vi.useFakeTimers();
    testConfigMock.mockReturnValue(new Promise<CopyTreeTestConfigResult>(() => {}));
    renderTab();

    const button = screen.getByRole("button", { name: "Test config" });
    await act(async () => {
      fireEvent.click(button);
    });

    // Before the 200ms skeleton gate, nothing is shown
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByRole("status", { name: "Running test configuration" })).toBeNull();

    // Crossing the 200ms gate reveals the skeleton
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status", { name: "Running test configuration" })).toBeTruthy();
  });

  it("never shows the skeleton when the dry-run resolves before the gate", async () => {
    vi.useFakeTimers();
    testConfigMock.mockResolvedValue(successResult);
    renderTab();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });
    // Resolves in a microtask, well before the 200ms gate — advancing past it
    // must not surface a skeleton.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByRole("status", { name: "Running test configuration" })).toBeNull();
    expect(screen.getByText("5 files would be included")).toBeTruthy();
  });

  it("renders the result card and hides the skeleton once the dry-run resolves", async () => {
    testConfigMock.mockResolvedValue(successResult);
    renderTab();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });

    await waitFor(() => {
      expect(screen.getByText("5 files would be included")).toBeTruthy();
    });
    expect(screen.queryByRole("status", { name: "Running test configuration" })).toBeNull();
  });

  it("renders an error card when the dry-run fails", async () => {
    testConfigMock.mockResolvedValue({
      includedFiles: 0,
      includedSize: 0,
      excluded: { byTruncation: 0, bySize: 0, byPattern: 0 },
      error: "Boom",
    } satisfies CopyTreeTestConfigResult);
    renderTab();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });

    await waitFor(() => {
      expect(screen.getByText("Boom")).toBeTruthy();
    });
  });
});

describe("ContextTab — DOM anchors for settings deep-links", () => {
  it("exposes the project-excluded-paths anchor for settings deep-links", () => {
    const { container } = renderTab();
    expect(container.querySelector("#project-excluded-paths")).not.toBeNull();
  });

  it("exposes the project-copy-tree anchor for settings deep-links", () => {
    const { container } = renderTab();
    expect(container.querySelector("#project-copy-tree")).not.toBeNull();
  });
});
