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
  excluded: { total: 6, byReason: { gitignore: 4, sizeGate: 2 } },
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
    expect(screen.getByText("Character budget")).toBeTruthy();
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
});

describe("ContextTab dry-run reporting", () => {
  async function runWith(result: Partial<CopyTreeTestConfigResult>) {
    testConfigMock.mockResolvedValue({ ...successResult, ...result });
    renderTab();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });
    await waitFor(() => {
      expect(screen.getByText("5 files would be included")).toBeTruthy();
    });
  }

  it("abbreviates large token estimates and leaves small ones exact", async () => {
    await runWith({ estimatedTokens: 78_400 });
    expect(screen.getByText("~78k tokens")).toBeTruthy();
  });

  it("shows an exact count below a thousand tokens", async () => {
    await runWith({ estimatedTokens: 640 });
    expect(screen.getByText("~640 tokens")).toBeTruthy();
  });

  it("omits the token estimate when the dry run did not report one", async () => {
    await runWith({ estimatedTokens: undefined });
    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it("names the largest exclusion reasons behind the excluded count", async () => {
    await runWith({
      excluded: { total: 12, byReason: { gitignore: 7, sizeGate: 4, duplicate: 1 } },
    });

    const line = screen.getByText(/12 excluded/).textContent ?? "";
    expect(line).toContain("gitignore");
    expect(line).toContain("max file size");
    // Ordered by count, so the largest reason leads.
    expect(line.indexOf("gitignore")).toBeLessThan(line.indexOf("max file size"));
  });

  it("stays quiet when nothing was excluded", async () => {
    await runWith({ excluded: { total: 0, byReason: {} } });
    expect(screen.queryByText(/\d+ excluded/)).toBeNull();
  });

  it("warns which budget dropped files when the run truncated", async () => {
    await runWith({ truncated: true, truncatedCount: 9, truncatedBy: "charLimit" });

    const warning = screen.getByText(/9 files were dropped/).textContent ?? "";
    expect(warning).toContain("character budget");
  });

  it("shows no truncation warning on an untruncated run", async () => {
    await runWith({ truncated: false });
    expect(screen.queryByText(/were dropped by/)).toBeNull();
  });

  it("renders an error card when the dry-run fails", async () => {
    testConfigMock.mockResolvedValue({
      includedFiles: 0,
      includedSize: 0,
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

describe("ContextTab test-config payload", () => {
  it("sends explicit null sentinels for every cleared field on an empty form", async () => {
    testConfigMock.mockResolvedValue(successResult);
    renderTab();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });

    // null (not omitted) — omitted keys are back-filled from saved settings in
    // the main process, which is the exact bug this guards against (#10004).
    expect(testConfigMock).toHaveBeenCalledWith("wt-1", {
      exclude: null,
      always: null,
      maxTotalSize: null,
      maxFileSize: null,
      charLimit: null,
      sort: null,
    });
  });

  it("sends form values for set fields and null for cleared fields", async () => {
    testConfigMock.mockResolvedValue(successResult);
    renderTab({
      excludedPaths: ["node_modules/**"],
      copyTreeSettings: { maxContextSize: 5000, strategy: "modified" } as CopyTreeSettings,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });

    expect(testConfigMock).toHaveBeenCalledWith("wt-1", {
      exclude: ["node_modules/**"],
      always: null,
      maxTotalSize: 5000,
      maxFileSize: null,
      charLimit: null,
      sort: "modified",
    });
  });

  it("treats whitespace-only patterns as cleared, sending null instead of empty entries", async () => {
    testConfigMock.mockResolvedValue(successResult);
    renderTab({ excludedPaths: ["   ", ""] });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });

    const [, options] = testConfigMock.mock.calls[0]!;
    expect(options.exclude).toBeNull();
  });
});

describe("ContextTab file-list preview", () => {
  function makeFiles(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      path: `src/file-${String(i).padStart(2, "0")}.ts`,
      size: 100 + i,
    }));
  }

  function resultWithFiles(files: Array<{ path: string; size: number }>): CopyTreeTestConfigResult {
    return {
      includedFiles: files.length,
      includedSize: files.reduce((sum, file) => sum + file.size, 0),
      files,
    };
  }

  async function runTestConfig() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test config" }));
    });
  }

  it("shows the first 10 files with a show-more toggle when more exist", async () => {
    testConfigMock.mockResolvedValue(resultWithFiles(makeFiles(12)));
    renderTab();

    await runTestConfig();
    await waitFor(() => {
      expect(screen.getByText("12 files would be included")).toBeTruthy();
    });

    expect(screen.getByText("src/file-09.ts")).toBeTruthy();
    expect(screen.queryByText("src/file-10.ts")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    });

    expect(screen.getByText("src/file-10.ts")).toBeTruthy();
    expect(screen.getByText("src/file-11.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer" })).toBeTruthy();
  });

  it("renders all files without a toggle when at the preview cap", async () => {
    testConfigMock.mockResolvedValue(resultWithFiles(makeFiles(10)));
    renderTab();

    await runTestConfig();
    await waitFor(() => {
      expect(screen.getByText("10 files would be included")).toBeTruthy();
    });

    expect(screen.getByText("src/file-00.ts")).toBeTruthy();
    expect(screen.getByText("src/file-09.ts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /show \d+ more/i })).toBeNull();
  });

  it("renders the summary without a file list when files is empty", async () => {
    testConfigMock.mockResolvedValue(resultWithFiles([]));
    renderTab();

    await runTestConfig();
    await waitFor(() => {
      expect(screen.getByText("0 files would be included")).toBeTruthy();
    });

    expect(screen.queryByRole("list")).toBeNull();
  });

  it("collapses the expanded list when a new test run starts", async () => {
    testConfigMock.mockResolvedValue(resultWithFiles(makeFiles(12)));
    renderTab();

    await runTestConfig();
    await waitFor(() => {
      expect(screen.getByText("12 files would be included")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    });
    expect(screen.getByText("src/file-11.ts")).toBeTruthy();

    await runTestConfig();
    await waitFor(() => {
      expect(screen.getByText("12 files would be included")).toBeTruthy();
    });

    expect(screen.queryByText("src/file-10.ts")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeTruthy();
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
