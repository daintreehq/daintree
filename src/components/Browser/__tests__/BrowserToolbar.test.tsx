// @vitest-environment jsdom
import { act, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BrowserToolbar } from "../BrowserToolbar";
import { normalizeBrowserUrl } from "../browserUtils";
import type { ViewportPresetId } from "@shared/types/panel";
import {
  VIEWPORT_PRESET_LIST,
  getEffectiveViewportSize,
  getViewportPreset,
} from "@/panels/dev-preview/viewportPresets";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockRemoveUrl = vi.fn();

const STABLE_ENTRIES = [
  {
    url: "http://localhost:3000/",
    title: "Home",
    visitCount: 5,
    lastVisitAt: 1700000000000,
    favicon: "https://example.com/favicon.ico",
  },
  {
    url: "http://localhost:5173/",
    title: "Vite",
    visitCount: 2,
    lastVisitAt: 1700000000000,
  },
];

vi.mock("@/store/urlHistoryStore", () => ({
  useUrlHistoryStore: Object.assign(() => STABLE_ENTRIES, {
    getState: () => ({ removeUrl: mockRemoveUrl }),
  }),
  getFrecencySuggestions: vi.fn((entries: typeof STABLE_ENTRIES) => entries),
}));

const rowWidth = vi.hoisted(() => ({ current: 1000 }));
vi.mock("@/hooks/useResizeObserverRaf", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    useResizeObserverRaf: (
      element: HTMLElement | null,
      onResize: (entry: { contentRect: { width: number } }) => void
    ) => {
      useLayoutEffect(() => {
        if (element) onResize({ contentRect: { width: rowWidth.current } });
      }, [element]);
    },
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
}));

const defaultProps = {
  url: "http://localhost:5173/",
  projectId: "proj1",
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  onNavigate: vi.fn(),
  onBack: vi.fn(),
  onForward: vi.fn(),
  onReload: vi.fn(),
  onOpenExternal: vi.fn(),
  canOpenExternal: true,
};

function renderToolbar(overrides = {}) {
  const props = { ...defaultProps, ...overrides };
  return render(<BrowserToolbar {...props} />);
}

function openDropdown(arg: ((id: string) => HTMLElement) | HTMLElement) {
  const input = typeof arg === "function" ? arg("browser-address-bar") : arg;
  fireEvent.focus(input);
  return input;
}

describe("BrowserToolbar handleSubmit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onReload when submitting the same URL", () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onReload).toHaveBeenCalledOnce();
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });

  it("calls onNavigate when submitting a different URL", () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "localhost:3000" } });
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onNavigate).toHaveBeenCalledWith("http://localhost:3000/");
    expect(defaultProps.onReload).not.toHaveBeenCalled();
  });

  it("calls onReload when display-format input normalizes to same URL", () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "localhost:5173" } });
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onReload).toHaveBeenCalledOnce();
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });

  it("shows error for invalid URL and does not call either callback", () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "not a valid url !!!" } });
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onReload).not.toHaveBeenCalled();
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });

  it("calls onReload on consecutive same-URL submissions", () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.submit(input.closest("form")!);
    fireEvent.focus(input);
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onReload).toHaveBeenCalledTimes(2);
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });

  it("calls onReload for URL with path, query, and hash", () => {
    const fullUrl = "http://localhost:5173/app?tab=1#section";
    const { getByTestId } = renderToolbar({ url: fullUrl });
    const input = openDropdown(getByTestId);

    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onReload).toHaveBeenCalledOnce();
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });

  // #9941: with no validateUrl prop the toolbar stays strict (DevPreview policy),
  // rejecting LAN hosts before onNavigate fires.
  it("rejects a LAN host in strict default mode (no validateUrl)", () => {
    const { getByTestId, container } = renderToolbar();
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "192.168.1.10:3000" } });
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
    expect(defaultProps.onReload).not.toHaveBeenCalled();
    // The inline error banner renders, confirming the host was actively rejected
    // rather than the submit silently no-op'ing.
    expect(container.querySelector(".text-status-error")).not.toBeNull();
  });

  // #9941: a validateUrl prop lets BrowserPane inject its extended policy so the
  // toolbar forwards LAN hosts instead of rejecting them inline.
  it("forwards a LAN host when validateUrl supplies extended policy", () => {
    const { getByTestId } = renderToolbar({
      validateUrl: (value: string) => normalizeBrowserUrl(value, { allowedHosts: [] }),
    });
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "192.168.1.10:3000" } });
    fireEvent.submit(input.closest("form")!);

    expect(defaultProps.onNavigate).toHaveBeenCalledWith("http://192.168.1.10:3000/");
    expect(defaultProps.onReload).not.toHaveBeenCalled();
  });

  // #9941: requiresConfirmation is not an error — the toolbar forwards the URL and
  // lets BrowserPane.handleNavigate raise the approval banner.
  it("forwards the URL when validateUrl returns requiresConfirmation", () => {
    const validateUrl = vi.fn(() => ({
      url: "http://tunnel.example.com/",
      requiresConfirmation: true,
      hostname: "tunnel.example.com",
    }));
    const { getByTestId } = renderToolbar({ validateUrl });
    const input = openDropdown(getByTestId);

    fireEvent.change(input, { target: { value: "tunnel.example.com" } });
    fireEvent.submit(input.closest("form")!);

    // validateUrl receives the edited input, not the current `url` prop.
    expect(validateUrl).toHaveBeenCalledWith("tunnel.example.com");
    expect(defaultProps.onNavigate).toHaveBeenCalledWith("http://tunnel.example.com/");
    expect(defaultProps.onReload).not.toHaveBeenCalled();
  });
});

describe("BrowserToolbar favicon and delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders favicon image for entries with favicon", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);
    const img = container.querySelector("img[src='https://example.com/favicon.ico']");
    expect(img).toBeTruthy();
  });

  it("renders Globe icon for entries without favicon", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);
    // Second entry has no favicon — should have a Globe SVG sibling
    const rows = container.querySelectorAll(".group\\/row");
    expect(rows.length).toBe(2);
  });

  it("delete button calls removeUrl on mousedown", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);
    const deleteButtons = container.querySelectorAll("[aria-label^='Remove']");
    expect(deleteButtons.length).toBeGreaterThan(0);
    fireEvent.mouseDown(deleteButtons[0]!);
    expect(mockRemoveUrl).toHaveBeenCalledWith("proj1", "http://localhost:3000/");
  });

  it("delete button does not navigate on click", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);
    const deleteButtons = container.querySelectorAll("[aria-label^='Remove']");
    fireEvent.mouseDown(deleteButtons[0]!);
    expect(defaultProps.onNavigate).not.toHaveBeenCalled();
  });
});

describe("BrowserToolbar ARIA semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("input has combobox role with accessible name and listbox controls", () => {
    const { getByTestId } = renderToolbar();
    const input = getByTestId("browser-address-bar");

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-label")).toBe("Address bar");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeTruthy();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("aria-expanded becomes true and aria-controls points at the listbox when open", () => {
    const { container, getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listboxId = input.getAttribute("aria-controls")!;
    const listbox = container.querySelector(`[id="${listboxId}"]`);
    expect(listbox).toBeTruthy();
    expect(listbox!.getAttribute("role")).toBe("listbox");
  });

  it("each suggestion is rendered as an option with stable id and aria-selected", () => {
    const { container, getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);
    const listboxId = input.getAttribute("aria-controls")!;

    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    options.forEach((option, index) => {
      expect(option.getAttribute("id")).toBe(`${listboxId}-option-${index}`);
      expect(option.getAttribute("aria-selected")).toBe("false");
    });
  });

  it("ArrowDown moves aria-activedescendant and flips aria-selected on options", async () => {
    const { container, getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);
    const listboxId = input.getAttribute("aria-controls")!;

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });

    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBe(`${listboxId}-option-0`);
    });
    const options = container.querySelectorAll('[role="option"]');
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options[1]!.getAttribute("aria-selected")).toBe("false");
  });

  it("aria-activedescendant clears when the dropdown closes", async () => {
    const { getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    });

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    await waitFor(() => {
      expect(input.getAttribute("aria-expanded")).toBe("false");
    });
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("Copy URL button is exposed by accessible name", () => {
    const { getByRole } = renderToolbar();
    const button = getByRole("button", { name: "Copy URL" });
    expect(button).toBeTruthy();
  });

  it("Open in browser button is exposed by accessible name", () => {
    const { getByRole } = renderToolbar();
    const button = getByRole("button", { name: "Open in browser" });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(defaultProps.onOpenExternal).toHaveBeenCalledOnce();
  });

  it("screenshot button accessible name matches its visible tooltip (WCAG 2.5.3)", () => {
    const onCaptureScreenshot = vi.fn();
    const { getByRole, queryByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: true,
    });
    // The visible tooltip reads "Copy screenshot to clipboard"; the accessible
    // name (aria-label) must contain it, so the stale "Capture screenshot" name
    // must be gone.
    expect(queryByRole("button", { name: "Capture screenshot" })).toBeNull();
    const button = getByRole("button", { name: "Copy screenshot to clipboard" });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onCaptureScreenshot).toHaveBeenCalledOnce();
  });

  it("screenshot button keeps its accessible name while disabled", () => {
    const onCaptureScreenshot = vi.fn();
    const { getByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: false,
    });
    const button = getByRole("button", { name: "Copy screenshot to clipboard" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onCaptureScreenshot).not.toHaveBeenCalled();
  });

  it("copy success announces in a polite live region", async () => {
    const { container, getByRole } = renderToolbar();

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy URL" }));
    });

    await waitFor(() => {
      const liveRegions = container.querySelectorAll('[role="status"]');
      const texts = Array.from(liveRegions).map((node) => node.textContent);
      expect(texts).toContain("Copied to clipboard");
    });
  });

  it("screenshot capture announces success in a polite live region and flips to a check", async () => {
    const onCaptureScreenshot = vi.fn(() => Promise.resolve(true));
    const { container, getByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: true,
    });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy screenshot to clipboard" }));
    });

    expect(onCaptureScreenshot).toHaveBeenCalledOnce();
    await waitFor(() => {
      const liveRegions = container.querySelectorAll('[role="status"]');
      const texts = Array.from(liveRegions).map((node) => node.textContent);
      expect(texts).toContain("Screenshot copied to clipboard");
    });
  });

  it("screenshot capture shows no success feedback when the handler reports failure", async () => {
    const onCaptureScreenshot = vi.fn(() => Promise.resolve(false));
    const { container, getByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: true,
    });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy screenshot to clipboard" }));
    });

    expect(onCaptureScreenshot).toHaveBeenCalledOnce();
    const liveRegions = container.querySelectorAll('[role="status"]');
    const texts = Array.from(liveRegions).map((node) => node.textContent);
    expect(texts).not.toContain("Screenshot copied to clipboard");
  });

  it("screenshot capture clears prior success feedback when a retry fails", async () => {
    const onCaptureScreenshot = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { container, getByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: true,
    });
    const button = getByRole("button", { name: "Copy screenshot to clipboard" });

    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      const texts = Array.from(container.querySelectorAll('[role="status"]')).map(
        (node) => node.textContent
      );
      expect(texts).toContain("Screenshot copied to clipboard");
    });

    await act(async () => {
      fireEvent.click(button);
    });

    const texts = Array.from(container.querySelectorAll('[role="status"]')).map(
      (node) => node.textContent
    );
    expect(texts).not.toContain("Screenshot copied to clipboard");
  });

  it("screenshot capture shows no success feedback when the handler rejects", async () => {
    const onCaptureScreenshot = vi.fn(() => Promise.reject(new Error("capture failed")));
    const { container, getByRole } = renderToolbar({
      onCaptureScreenshot,
      isWebviewReady: true,
    });

    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Copy screenshot to clipboard" }));
    });

    expect(onCaptureScreenshot).toHaveBeenCalledOnce();
    const liveRegions = container.querySelectorAll('[role="status"]');
    const texts = Array.from(liveRegions).map((node) => node.textContent);
    expect(texts).not.toContain("Screenshot copied to clipboard");
  });

  it("Shift+Delete on a highlighted suggestion announces removal", async () => {
    const { container, getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    });

    act(() => {
      fireEvent.keyDown(input, { key: "Delete", shiftKey: true });
    });

    await waitFor(() => {
      const liveRegions = container.querySelectorAll('[role="status"]');
      const texts = Array.from(liveRegions).map((node) => node.textContent);
      expect(texts.some((t) => t?.startsWith("Removed ") && t.endsWith("from history"))).toBe(true);
    });
  });

  it("X removal button is hidden from the accessibility tree", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);

    const removeButtons = container.querySelectorAll("[aria-label^='Remove']");
    expect(removeButtons.length).toBeGreaterThan(0);
    removeButtons.forEach((button) => {
      expect(button.getAttribute("aria-hidden")).toBe("true");
      expect(button.getAttribute("tabindex")).toBe("-1");
    });
  });

  it("re-announces when the same display URL is removed twice in a row", async () => {
    const { container, getByTestId } = renderToolbar();
    const input = openDropdown(getByTestId);

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    await waitFor(() => {
      expect(input.getAttribute("aria-activedescendant")).toBeTruthy();
    });

    act(() => {
      fireEvent.keyDown(input, { key: "Delete", shiftKey: true });
    });
    await waitFor(() => {
      const text = container.querySelector('[role="status"]')?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
    });
    const firstAnnouncement = container.querySelector('[role="status"]')!.textContent!;

    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Delete", shiftKey: true });
    });
    await waitFor(() => {
      const text = container.querySelector('[role="status"]')!.textContent!;
      expect(text).not.toBe(firstAnnouncement);
    });
  });

  it("clicking the row body (not the inner remove button) navigates", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);
    const option = container.querySelector('[role="option"]')!;
    fireEvent.mouseDown(option);
    expect(defaultProps.onNavigate).toHaveBeenCalledWith("http://localhost:3000/");
  });

  it("X removal label uses display URL not the raw URL", () => {
    const { container } = renderToolbar();
    openDropdown(container.querySelector("[data-testid='browser-address-bar']")! as HTMLElement);

    const removeButton = container.querySelector("[aria-label^='Remove']");
    expect(removeButton).toBeTruthy();
    const label = removeButton!.getAttribute("aria-label")!;
    expect(label).not.toContain("http://");
    expect(label).toMatch(/^Remove .+ from history$/);
  });
});

describe("BrowserToolbar console button capability gate (#7495)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render the console toggle when onToggleConsole is omitted", () => {
    const { queryByLabelText } = renderToolbar();
    expect(queryByLabelText("Toggle console")).toBeNull();
  });

  it("renders the console toggle when onToggleConsole is provided", () => {
    const onToggleConsole = vi.fn();
    const { getByLabelText } = renderToolbar({ onToggleConsole, canToggleConsole: true });
    const button = getByLabelText("Toggle console");
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onToggleConsole).toHaveBeenCalledOnce();
  });

  it("reflects isConsoleOpen state via aria-pressed when toggle is provided", () => {
    const { getByLabelText } = renderToolbar({
      onToggleConsole: vi.fn(),
      canToggleConsole: true,
      isConsoleOpen: true,
    });
    expect(getByLabelText("Toggle console").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("BrowserToolbar actions with nothing to act on (#12395)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disables Open in browser when there is no URL to open", () => {
    const onOpenExternal = vi.fn();
    const { getByRole } = renderToolbar({ url: "", onOpenExternal, canOpenExternal: false });
    const button = getByRole("button", { name: "Open in browser" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onOpenExternal).not.toHaveBeenCalled();
  });

  it("follows canOpenExternal rather than the URL or address-bar draft", () => {
    const onOpenExternal = vi.fn();
    const { getByRole, getByTestId } = renderToolbar({
      url: "http://localhost:5173/",
      onOpenExternal,
      canOpenExternal: false,
    });
    fireEvent.change(getByTestId("browser-address-bar"), {
      target: { value: "http://localhost:5173/" },
    });
    expect(getByRole("button", { name: "Open in browser" })).toHaveProperty("disabled", true);
  });

  it("does not tie Open in browser to webview readiness or loading", () => {
    const onOpenExternal = vi.fn();
    const { getByRole } = renderToolbar({
      onOpenExternal,
      canOpenExternal: true,
      isWebviewReady: false,
      isLoading: true,
    });
    const button = getByRole("button", { name: "Open in browser" });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onOpenExternal).toHaveBeenCalledOnce();
  });

  it("enables Open in browser once a URL arrives", () => {
    const onOpenExternal = vi.fn();
    const { getByRole, rerender } = render(
      <BrowserToolbar
        {...defaultProps}
        url=""
        onOpenExternal={onOpenExternal}
        canOpenExternal={false}
      />
    );
    expect(getByRole("button", { name: "Open in browser" })).toHaveProperty("disabled", true);

    rerender(
      <BrowserToolbar
        {...defaultProps}
        url="http://localhost:5173/"
        onOpenExternal={onOpenExternal}
        canOpenExternal={true}
      />
    );
    const button = getByRole("button", { name: "Open in browser" });
    expect(button).toHaveProperty("disabled", false);
    fireEvent.click(button);
    expect(onOpenExternal).toHaveBeenCalledOnce();
  });

  it("disables the console toggle when there is no console terminal", () => {
    const onToggleConsole = vi.fn();
    const { getByLabelText } = renderToolbar({ onToggleConsole, canToggleConsole: false });
    const button = getByLabelText("Toggle console");
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onToggleConsole).not.toHaveBeenCalled();
  });

  it("treats a console toggle without canToggleConsole as unavailable", () => {
    const { getByLabelText } = renderToolbar({ onToggleConsole: vi.fn() });
    expect(getByLabelText("Toggle console")).toHaveProperty("disabled", true);
  });

  it("does not show the console as pressed when there is no drawer to show", () => {
    const { getByLabelText, container } = renderToolbar({
      onToggleConsole: vi.fn(),
      canToggleConsole: false,
      isConsoleOpen: true,
    });
    expect(getByLabelText("Toggle console").getAttribute("aria-pressed")).toBe("false");
    expect(container.textContent).toContain("Show console");
    expect(container.textContent).not.toContain("Hide console");
  });

  it("wraps each button in a hover target only while it is disabled", () => {
    const { getByRole, getByLabelText, rerender } = render(
      <BrowserToolbar
        {...defaultProps}
        onToggleConsole={vi.fn()}
        canOpenExternal={false}
        canToggleConsole={false}
      />
    );
    expect(getByRole("button", { name: "Open in browser" }).parentElement?.tagName).toBe("SPAN");
    expect(getByLabelText("Toggle console").parentElement?.tagName).toBe("SPAN");

    rerender(
      <BrowserToolbar
        {...defaultProps}
        onToggleConsole={vi.fn()}
        canOpenExternal={true}
        canToggleConsole={true}
      />
    );
    expect(getByRole("button", { name: "Open in browser" }).parentElement?.tagName).not.toBe(
      "SPAN"
    );
    expect(getByLabelText("Toggle console").parentElement?.tagName).not.toBe("SPAN");
  });

  it("restores the pressed console once a terminal returns", () => {
    const onToggleConsole = vi.fn();
    const { getByLabelText, rerender } = render(
      <BrowserToolbar
        {...defaultProps}
        onToggleConsole={onToggleConsole}
        canToggleConsole={false}
        isConsoleOpen={true}
      />
    );
    expect(getByLabelText("Toggle console").getAttribute("aria-pressed")).toBe("false");

    rerender(
      <BrowserToolbar
        {...defaultProps}
        onToggleConsole={onToggleConsole}
        canToggleConsole={true}
        isConsoleOpen={true}
      />
    );
    const button = getByLabelText("Toggle console");
    expect(button).toHaveProperty("disabled", false);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onToggleConsole).toHaveBeenCalledOnce();
  });
});

describe("BrowserToolbar address-bar scheme icon and input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Lock icon when URL scheme is https", () => {
    const { queryByTestId } = renderToolbar({ url: "https://example.com/" });
    expect(queryByTestId("browser-url-scheme-lock")).toBeTruthy();
    expect(queryByTestId("browser-url-scheme-globe")).toBeFalsy();
  });

  it("renders Globe icon when URL scheme is http", () => {
    const { queryByTestId } = renderToolbar({ url: "http://localhost:3000/" });
    expect(queryByTestId("browser-url-scheme-globe")).toBeTruthy();
    expect(queryByTestId("browser-url-scheme-lock")).toBeFalsy();
  });

  it("renders Globe icon for malformed URL without throwing", () => {
    const { queryByTestId } = renderToolbar({ url: "" });
    expect(queryByTestId("browser-url-scheme-globe")).toBeTruthy();
    expect(queryByTestId("browser-url-scheme-lock")).toBeFalsy();
  });

  it("reload becomes Stop while loading, and stops rather than reloading", () => {
    const onStop = vi.fn();
    const onReload = vi.fn();
    const { getByTestId } = renderToolbar({ isLoading: true, onStop, onReload });
    const button = getByTestId("browser-reload");
    expect(button.getAttribute("aria-label")).toBe("Stop loading");
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledOnce();
    expect(onReload).not.toHaveBeenCalled();
  });

  it("reload stays Reload when idle, or when the host cannot stop a load", () => {
    const onReload = vi.fn();
    const idle = renderToolbar({ isLoading: false, onStop: vi.fn(), onReload });
    expect(idle.getByTestId("browser-reload").getAttribute("aria-label")).toBe("Reload");
    idle.unmount();

    const noStop = renderToolbar({ isLoading: true, onReload });
    const button = noStop.getByTestId("browser-reload");
    expect(button.getAttribute("aria-label")).toBe("Reload");
    fireEvent.click(button);
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("scheme icon is decorative and hidden from the accessibility tree", () => {
    const lock = renderToolbar({ url: "https://example.com/" }).getByTestId(
      "browser-url-scheme-lock"
    );
    expect(lock.getAttribute("aria-hidden")).toBe("true");

    const globe = renderToolbar({ url: "http://localhost:3000/" }).getByTestId(
      "browser-url-scheme-globe"
    );
    expect(globe.getAttribute("aria-hidden")).toBe("true");
  });

  it("address bar exposes a focus-visible ring without suppressing the forced-colors outline", () => {
    const { getByTestId } = renderToolbar();
    const input = getByTestId("browser-address-bar");
    // A focus-visible indicator must be present (the accent ring is the address bar's
    // sole accent signal per CLAUDE.md) and outline-hidden must be preserved so the
    // transparent forced-colors outline survives (lesson #6185 — never outline-none).
    expect(input.className).toContain("focus-visible:outline-accent-primary");
    expect(input.className).toContain("focus:outline-hidden");
    expect(input.className).not.toContain("outline-none");
  });
});

describe("BrowserToolbar viewport presets", () => {
  const onViewportPresetChange = vi.fn();

  function renderWithViewport(overrides = {}) {
    return renderToolbar({
      onViewportPresetChange,
      viewportPreset: "iphone" as ViewportPresetId,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function deviceTrigger() {
    return document.querySelector('[aria-label^="Device:"]') as HTMLElement;
  }

  async function openDeviceMenu() {
    fireEvent.pointerDown(deviceTrigger(), { button: 0, ctrlKey: false });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
    return Array.from(document.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[];
  }

  describe("device bar", () => {
    it("is absent until a preset is on, and never shares the address row", () => {
      const { queryByTestId, rerender } = renderWithViewport({ viewportPreset: undefined });
      expect(queryByTestId("browser-viewport-controls")).toBeNull();

      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onViewportPresetChange}
          viewportPreset="iphone"
        />
      );
      const bar = queryByTestId("browser-viewport-controls")!;
      expect(bar).toBeTruthy();
      // Entering device mode must not take width from the address.
      expect(bar.contains(document.querySelector('[data-testid="browser-address-bar"]'))).toBe(
        false
      );
    });

    it("names the active device on its trigger", () => {
      renderWithViewport({ viewportPreset: "pixel" });
      const label = getViewportPreset("pixel").label;
      expect(deviceTrigger().getAttribute("aria-label")).toBe(`Device: ${label}`);
      expect(deviceTrigger().textContent).toContain(label);
    });

    it("shows the effective size, swapped when rotated", () => {
      const { getByTestId, rerender } = renderWithViewport({ viewportPreset: "ipad" });
      const portrait = getEffectiveViewportSize("ipad", false);
      expect(getByTestId("browser-viewport-size").textContent).toBe(
        `${portrait.width} × ${portrait.height}`
      );
      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onViewportPresetChange}
          viewportPreset="ipad"
          viewportRotated
        />
      );
      const landscape = getEffectiveViewportSize("ipad", true);
      expect(getByTestId("browser-viewport-size").textContent).toBe(
        `${landscape.width} × ${landscape.height}`
      );
    });

    it("lists every preset once, with the active one checked", async () => {
      renderWithViewport({ viewportPreset: "pixel" });
      const items = await openDeviceMenu();
      expect(items.map((i) => i.getAttribute("data-viewport-preset-id"))).toEqual(
        VIEWPORT_PRESET_LIST.map((p) => p.id)
      );
      const checked = items.filter((i) => i.getAttribute("aria-checked") === "true");
      expect(checked.map((i) => i.getAttribute("data-viewport-preset-id"))).toEqual(["pixel"]);
    });

    it("selects a different preset, and choosing the active one changes nothing", async () => {
      renderWithViewport({ viewportPreset: "iphone" });
      let items = await openDeviceMenu();
      fireEvent.click(items.find((i) => i.getAttribute("data-viewport-preset-id") === "iphone")!);
      expect(onViewportPresetChange).not.toHaveBeenCalled();

      items = await openDeviceMenu();
      fireEvent.click(items.find((i) => i.getAttribute("data-viewport-preset-id") === "ipad")!);
      expect(onViewportPresetChange).toHaveBeenCalledWith("ipad");
    });
  });

  describe("device mode toggle", () => {
    function toggle() {
      return document.querySelector('[aria-label="Device mode"]') as HTMLElement;
    }

    it("reports its state through aria-pressed", () => {
      const { rerender } = renderWithViewport({ viewportPreset: undefined });
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onViewportPresetChange}
          viewportPreset="pixel"
        />
      );
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
    });

    it("turns device mode off when on", () => {
      renderWithViewport({ viewportPreset: "pixel" });
      fireEvent.click(toggle());
      expect(onViewportPresetChange).toHaveBeenCalledWith(undefined);
    });

    it("falls back to 'iphone' on first enable", () => {
      renderWithViewport({ viewportPreset: undefined });
      fireEvent.click(toggle());
      expect(onViewportPresetChange).toHaveBeenCalledWith("iphone");
    });

    it("restores the last-used preset when re-enabled", () => {
      const { rerender } = renderWithViewport({ viewportPreset: "ipad" });
      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onViewportPresetChange}
          viewportPreset={undefined}
        />
      );
      fireEvent.click(toggle());
      expect(onViewportPresetChange).toHaveBeenLastCalledWith("ipad");
    });
  });

  describe("DPR radiogroup keyboard navigation", () => {
    function renderWithDpr(overrides = {}) {
      return renderWithViewport({ onViewportDprChange: vi.fn(), viewportDpr: 1, ...overrides });
    }

    function dprRadios() {
      const group = document.querySelector('[aria-label="Device pixel ratio"]')!;
      return Array.from(group.querySelectorAll('[role="radio"]')) as HTMLElement[];
    }

    it("renders a DPR radiogroup with one radio per ratio", () => {
      renderWithDpr();
      const radios = dprRadios();
      expect(radios.map((r) => r.getAttribute("data-dpr"))).toEqual(["1", "2", "3"]);
    });

    it("ArrowRight moves focus to the next ratio and selection follows focus", () => {
      const onViewportDprChange = vi.fn();
      renderWithDpr({ onViewportDprChange });
      const radios = dprRadios();

      radios[0]!.focus();
      fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });

      expect(document.activeElement).toBe(radios[1]);
      expect(onViewportDprChange).toHaveBeenCalledWith(2);
    });

    it("ArrowRight wraps from the last ratio back to the first", () => {
      renderWithDpr({ viewportDpr: 3 });
      const radios = dprRadios();

      radios[2]!.focus();
      fireEvent.keyDown(radios[2]!, { key: "ArrowRight" });

      expect(document.activeElement).toBe(radios[0]);
    });

    it("Home/End jump to the first and last ratios", () => {
      renderWithDpr({ viewportDpr: 2 });
      const radios = dprRadios();

      radios[1]!.focus();
      fireEvent.keyDown(radios[1]!, { key: "Home" });
      expect(document.activeElement).toBe(radios[0]);

      fireEvent.keyDown(radios[0]!, { key: "End" });
      expect(document.activeElement).toBe(radios[2]);
    });
  });
});

describe("BrowserToolbar address presentation", () => {
  const PROXY_URL = "http://dp-proj-panel.localhost:43000/dashboard?tab=billing";
  const toAddress = (url: string) =>
    url.replace("http://dp-proj-panel.localhost:43000", "http://localhost:5173");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows, edits and copies the mapped address, never the webview's own origin", async () => {
    const { actionService } = await import("@/services/ActionService");
    const { getByTestId, getByLabelText } = renderToolbar({ url: PROXY_URL, toAddress });
    const input = getByTestId("browser-address-bar") as HTMLInputElement;
    expect(input.value).not.toContain("dp-proj-panel");
    expect(getByTestId("browser-address-display").textContent).toBe(
      "localhost:5173/dashboard?tab=billing"
    );

    fireEvent.focus(input);
    expect(input.value).toBe(toAddress(PROXY_URL));

    fireEvent.click(getByLabelText("Copy URL"));
    await waitFor(() =>
      expect(actionService.dispatch).toHaveBeenCalledWith(
        "browser.copyUrl",
        expect.objectContaining({ url: toAddress(PROXY_URL) }),
        expect.anything()
      )
    );
  });

  it("gives the route its own run so it can outlast the host when space is short", () => {
    const { getByTestId } = renderToolbar({ url: PROXY_URL, toAddress });
    const runs = Array.from(getByTestId("browser-address-display").children);
    expect(runs.map((r) => r.textContent)).toEqual(["localhost:5173", "/dashboard?tab=billing"]);
  });
});

describe("BrowserToolbar keyboard activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Enter/Space on back and forward navigate (keyboard clicks carry detail 0)", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    const { getByTestId } = renderToolbar({
      canGoBack: true,
      canGoForward: true,
      onBack,
      onForward,
    });
    fireEvent.click(getByTestId("browser-back"), { detail: 0 });
    fireEvent.click(getByTestId("browser-forward"), { detail: 0 });
    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
  });

  it("a pointer press navigates once, on pointer-up, not again on its click", () => {
    const onBack = vi.fn();
    const { getByTestId } = renderToolbar({ canGoBack: true, onBack });
    const back = getByTestId("browser-back");
    fireEvent.pointerDown(back, { button: 0 });
    fireEvent.pointerUp(back, { button: 0 });
    fireEvent.click(back, { detail: 1 });
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("BrowserToolbar address validation", () => {
  it("ties a rejected address to its message and closes the suggestions", () => {
    const { getByTestId, getByRole, queryByRole } = renderToolbar({
      validateUrl: () => ({ error: "Only localhost addresses open here, not example.com" }),
    });
    const input = openDropdown(getByTestId("browser-address-bar"));
    expect(queryByRole("listbox")).toBeTruthy();
    fireEvent.change(input, { target: { value: "https://example.com" } });
    fireEvent.submit(input.closest("form")!);

    const alert = getByRole("alert");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(queryByRole("listbox")).toBeNull();
  });
});

describe("BrowserToolbar zoom", () => {
  it("keeps zoom out of the toolbar at 100% and surfaces it once it changes", () => {
    const onZoomChange = vi.fn();
    const { queryByTestId, rerender } = renderToolbar({ onZoomChange, zoomFactor: 1 });
    expect(queryByTestId("browser-zoom-indicator")).toBeNull();
    rerender(<BrowserToolbar {...defaultProps} onZoomChange={onZoomChange} zoomFactor={1.25} />);
    expect(queryByTestId("browser-zoom-indicator")?.textContent).toContain("125%");
  });

  it("offers zoom, DevTools and Portal from the More menu", async () => {
    const onZoomChange = vi.fn();
    const onToggleDevTools = vi.fn();
    const onPromoteToPortal = vi.fn();
    const { getByLabelText } = renderToolbar({
      onZoomChange,
      onToggleDevTools,
      onPromoteToPortal,
      isWebviewReady: true,
    });
    fireEvent.pointerDown(getByLabelText("More page actions"), { button: 0, ctrlKey: false });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const labels = items.map((i) => i.textContent?.trim());
    expect(labels).toEqual(
      expect.arrayContaining(["Zoom in", "Zoom out", "Toggle DevTools", "Open in Portal"])
    );
    fireEvent.click(items.find((i) => i.textContent?.trim() === "Zoom in")!);
    expect(onZoomChange).toHaveBeenCalledWith(1.25);
  });
});

describe("BrowserToolbar history on a mapped address", () => {
  it("matches what was typed against the shown address, and rows keep the stored URL", async () => {
    const { getFrecencySuggestions } = await import("@/store/urlHistoryStore");
    const spy = vi.mocked(getFrecencySuggestions);
    const toAddress = (url: string) => url.replace("localhost:3000", "shown.test:1");
    const { getByTestId } = renderToolbar({ toAddress });
    const input = openDropdown(getByTestId("browser-address-bar"));
    fireEvent.change(input, { target: { value: "shown.test" } });
    const searched = spy.mock.calls.at(-1)![0].map((e: { url: string }) => e.url);
    expect(searched).toContain("http://shown.test:1/");
    expect(searched).not.toContain("http://localhost:3000/");
    const onNavigate = defaultProps.onNavigate;
    fireEvent.mouseDown(document.querySelectorAll('[role="option"]')[0]!);
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:3000/");
  });
});

describe("BrowserToolbar at compact widths", () => {
  beforeEach(() => {
    rowWidth.current = 500;
  });
  afterEach(() => {
    rowWidth.current = 1000;
  });

  it("confirms a copy from More on the More trigger, since the in-field check is gone", async () => {
    const { getByLabelText } = renderToolbar();
    const more = getByLabelText("More page actions");
    const glyphBefore = more.innerHTML;
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
    const copyItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (i) => i.textContent?.trim() === "Copy URL"
    )!;
    fireEvent.click(copyItem);
    await waitFor(() =>
      expect(getByLabelText("More page actions").innerHTML).not.toBe(glyphBefore)
    );
    expect(getByLabelText("More page actions").querySelector(".text-status-success")).toBeTruthy();
  });

  it("keeps the route by moving Copy URL and the console toggle into More", async () => {
    const onToggleConsole = vi.fn();
    const { queryByLabelText, getByLabelText } = renderToolbar({
      onToggleConsole,
      canToggleConsole: true,
    });
    expect(queryByLabelText("Copy URL")).toBeNull();
    expect(queryByLabelText("Toggle console")).toBeNull();

    fireEvent.pointerDown(getByLabelText("More page actions"), { button: 0, ctrlKey: false });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
    const consoleItem = document.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
    expect(consoleItem.textContent).toContain("Console");
    fireEvent.click(consoleItem);
    expect(onToggleConsole).toHaveBeenCalledOnce();
  });
});

describe("BrowserToolbar after a commit", () => {
  it("typing again in a still-focused field shows the text, not the resting overlay", () => {
    const { getByTestId, queryByTestId } = renderToolbar({ url: "http://localhost:5173/a" });
    const input = getByTestId("browser-address-bar") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "localhost:5173/b" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.change(input, { target: { value: "localhost:5173/c" } });
    expect(queryByTestId("browser-address-display")).toBeNull();
    expect(input.className).not.toContain("text-transparent");
    expect(input.value).toBe("localhost:5173/c");
  });
});
