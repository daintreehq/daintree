// @vitest-environment jsdom
import { act, render, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BrowserToolbar } from "../BrowserToolbar";
import { normalizeBrowserUrl } from "../browserUtils";
import type { ViewportPresetId } from "@shared/types/panel";

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
  getFrecencySuggestions: () => STABLE_ENTRIES,
}));

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
    const { getByLabelText } = renderToolbar({ onToggleConsole });
    const button = getByLabelText("Toggle console");
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onToggleConsole).toHaveBeenCalledOnce();
  });

  it("reflects isConsoleOpen state via aria-pressed when toggle is provided", () => {
    const { getByLabelText } = renderToolbar({
      onToggleConsole: vi.fn(),
      isConsoleOpen: true,
    });
    expect(getByLabelText("Toggle console").getAttribute("aria-pressed")).toBe("true");
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

  it("reload button has animate-spin when isLoading is true", () => {
    const { getByTestId } = renderToolbar({ isLoading: true });
    const reload = getByTestId("browser-reload");
    expect(reload.className).toContain("animate-spin");
  });

  it("reload button does not have animate-spin when isLoading is false", () => {
    const { getByTestId } = renderToolbar({ isLoading: false });
    const reload = getByTestId("browser-reload");
    expect(reload.className).not.toContain("animate-spin");
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

  describe("radiogroup semantics", () => {
    it("chip container has radiogroup role and accessible name", () => {
      renderWithViewport();
      const group = document.querySelector('[role="radiogroup"]');
      expect(group).toBeTruthy();
      expect(group!.getAttribute("aria-label")).toBe("Select viewport preset");
    });

    it("each chip is a radio with aria-checked reflecting selection", () => {
      renderWithViewport();
      const radios = document.querySelectorAll('[role="radio"]');
      expect(radios.length).toBe(4);

      const galaxyRadio = document.querySelector('[data-viewport-preset-id="galaxy"]');
      expect(galaxyRadio!.getAttribute("aria-checked")).toBe("false");

      const iphoneRadio = document.querySelector('[data-viewport-preset-id="iphone"]');
      expect(iphoneRadio!.getAttribute("aria-checked")).toBe("true");

      const pixelRadio = document.querySelector('[data-viewport-preset-id="pixel"]');
      expect(pixelRadio!.getAttribute("aria-checked")).toBe("false");

      const ipadRadio = document.querySelector('[data-viewport-preset-id="ipad"]');
      expect(ipadRadio!.getAttribute("aria-checked")).toBe("false");
    });

    it("selected radio has tabIndex 0, others have -1", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector('[data-viewport-preset-id="iphone"]');
      expect(iphoneRadio!.getAttribute("tabindex")).toBe("0");

      const pixelRadio = document.querySelector('[data-viewport-preset-id="pixel"]');
      expect(pixelRadio!.getAttribute("tabindex")).toBe("-1");
    });

    it("has aria-label matching preset label", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector('[data-viewport-preset-id="iphone"]');
      expect(iphoneRadio!.getAttribute("aria-label")).toBe("iPhone 17");

      const galaxyRadio = document.querySelector('[data-viewport-preset-id="galaxy"]');
      expect(galaxyRadio!.getAttribute("aria-label")).toBe("Galaxy S26");
    });
  });

  describe("armed-state styling", () => {
    it("selected preset chip drives state via toolbar-icon-button + aria-checked, not a hardcoded fill", () => {
      renderWithViewport();
      const selected = document.querySelector('[data-viewport-preset-id="iphone"]')! as HTMLElement;
      // The selected chip must participate in the theme-aware armed-state recipe
      // (toolbar.css keys off .toolbar-icon-button[aria-checked="true"]) rather than
      // hardcoding bg-overlay-emphasis, which reads as a dark smudge on light themes.
      expect(selected.getAttribute("aria-checked")).toBe("true");
      expect(selected.className).toContain("toolbar-icon-button");
      expect(selected.className).not.toContain("bg-overlay-emphasis");
    });

    it("selected DPR chip uses the same armed-state contract", () => {
      renderWithViewport({ onViewportDprChange: vi.fn(), viewportDpr: 2 });
      const dprGroup = document.querySelector('[aria-label="Device pixel ratio"]')!;
      const selected = Array.from(dprGroup.querySelectorAll('[role="radio"]')).find(
        (r) => r.getAttribute("aria-checked") === "true"
      ) as HTMLElement;
      expect(selected).toBeTruthy();
      expect(selected.getAttribute("data-dpr")).toBe("2");
      expect(selected.className).toContain("toolbar-icon-button");
      expect(selected.className).not.toContain("bg-overlay-emphasis");
    });
  });

  describe("chip click behavior", () => {
    it("selects a different preset on click", () => {
      renderWithViewport();
      const pixelRadio = document.querySelector('[data-viewport-preset-id="pixel"]')!;
      fireEvent.click(pixelRadio);
      expect(onViewportPresetChange).toHaveBeenCalledWith("pixel");
    });

    it("clicking already-selected chip is a no-op", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector('[data-viewport-preset-id="iphone"]')!;
      fireEvent.click(iphoneRadio);
      expect(onViewportPresetChange).not.toHaveBeenCalled();
    });
  });

  describe("toggle persistence", () => {
    it("restores last-used preset when toggle re-enables (round-trip)", () => {
      const onPresetChange = vi.fn();
      const { rerender, container } = render(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onPresetChange}
          viewportPreset="iphone"
        />
      );

      // Switch to Pixel
      fireEvent.click(container.querySelector('[data-viewport-preset-id="pixel"]')!);
      expect(onPresetChange).toHaveBeenCalledWith("pixel");
      onPresetChange.mockClear();

      // Parent updates viewportPreset to pixel
      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onPresetChange}
          viewportPreset="pixel"
        />
      );
      onPresetChange.mockClear();

      // Toggle off
      fireEvent.click(container.querySelector('[aria-label="Viewport preset"]')!);
      expect(onPresetChange).toHaveBeenCalledWith(undefined);
      onPresetChange.mockClear();

      // Rerender with undefined (parent processes the callback)
      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onPresetChange}
          viewportPreset={undefined}
        />
      );
      onPresetChange.mockClear();

      // Toggle re-enables — should restore "pixel", not "iphone"
      fireEvent.click(container.querySelector('[aria-label="Viewport preset"]')!);
      expect(onPresetChange).toHaveBeenCalledWith("pixel");
    });

    it("falls back to 'iphone' on first enable", () => {
      renderToolbar({ onViewportPresetChange });
      const toggle = document.querySelector('[aria-label="Viewport preset"]');
      fireEvent.click(toggle!);
      expect(onViewportPresetChange).toHaveBeenCalledWith("iphone");
    });

    it("chip row is absent when viewportPreset is undefined", () => {
      renderToolbar({ onViewportPresetChange, viewportPreset: undefined });
      expect(document.querySelector('[role="radiogroup"]')).toBeNull();
      const toggle = document.querySelector('[aria-label="Viewport preset"]');
      expect(toggle!.getAttribute("aria-pressed")).toBe("false");
    });
  });

  describe("tooltip", () => {
    it("tooltip content is static text", () => {
      const { container } = renderWithViewport();
      // Tooltips are mocked to render their content directly
      expect(container.textContent).toContain("Viewport preset");
    });
  });

  describe("keyboard navigation", () => {
    it("ArrowRight moves focus to next radio", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;
      const pixelRadio = document.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowRight" });

      expect(document.activeElement).toBe(pixelRadio);
    });

    it("ArrowLeft wraps from first to last", () => {
      renderWithViewport();
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;
      const ipadRadio = document.querySelector('[data-viewport-preset-id="ipad"]')! as HTMLElement;

      galaxyRadio.focus();
      fireEvent.keyDown(galaxyRadio, { key: "ArrowLeft" });

      expect(document.activeElement).toBe(ipadRadio);
    });

    it("ArrowRight wraps from last to first", () => {
      renderWithViewport();
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;
      const ipadRadio = document.querySelector('[data-viewport-preset-id="ipad"]')! as HTMLElement;

      ipadRadio.focus();
      fireEvent.keyDown(ipadRadio, { key: "ArrowRight" });

      expect(document.activeElement).toBe(galaxyRadio);
    });

    it("Home moves focus to first radio", () => {
      renderWithViewport();
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;
      const ipadRadio = document.querySelector('[data-viewport-preset-id="ipad"]')! as HTMLElement;

      ipadRadio.focus();
      fireEvent.keyDown(ipadRadio, { key: "Home" });

      expect(document.activeElement).toBe(galaxyRadio);
    });

    it("End moves focus to last radio", () => {
      renderWithViewport();
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;
      const ipadRadio = document.querySelector('[data-viewport-preset-id="ipad"]')! as HTMLElement;

      galaxyRadio.focus();
      fireEvent.keyDown(galaxyRadio, { key: "End" });

      expect(document.activeElement).toBe(ipadRadio);
    });

    it("Space selects the focused radio", () => {
      renderWithViewport();
      const pixelRadio = document.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;

      pixelRadio.focus();
      fireEvent.keyDown(pixelRadio, { key: " " });

      expect(onViewportPresetChange).toHaveBeenCalledWith("pixel");
    });

    it("Enter selects the focused radio", () => {
      renderWithViewport();
      const padRadio = document.querySelector('[data-viewport-preset-id="ipad"]')! as HTMLElement;

      padRadio.focus();
      fireEvent.keyDown(padRadio, { key: "Enter" });

      expect(onViewportPresetChange).toHaveBeenCalledWith("ipad");
    });

    it("Space on already-selected radio is a no-op", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: " " });

      expect(onViewportPresetChange).not.toHaveBeenCalled();
    });

    it("ArrowDown moves focus forward like ArrowRight", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;
      const pixelRadio = document.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowDown" });

      expect(document.activeElement).toBe(pixelRadio);
    });

    it("ArrowUp moves focus backward like ArrowLeft", () => {
      renderWithViewport();
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowUp" });

      expect(document.activeElement).toBe(galaxyRadio);
    });

    it("maintains roving tabIndex after ArrowRight focus move", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;
      const pixelRadio = document.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowRight" });

      expect(pixelRadio.getAttribute("tabindex")).toBe("0");
    });

    it("keeps exactly one radio tabbable after ArrowRight (no transient dual tab stop)", () => {
      // The roving-tabindex contract requires a single tab stop. Before the fix,
      // the freshly focused chip AND the still-selected chip both reported
      // tabIndex=0 until the parent rerendered with the new preset, briefly
      // exposing two tab stops to keyboard/AT users.
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowRight" });

      const tabbable = Array.from(document.querySelectorAll('[role="radio"]')).filter(
        (r) => r.getAttribute("tabindex") === "0"
      );
      expect(tabbable.length).toBe(1);
    });

    it("ArrowRight on the focused radio activates the next preset immediately (APG automatic activation)", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowRight" });

      expect(onViewportPresetChange).toHaveBeenCalledWith("pixel");
    });

    it("ArrowDown also fires onViewportPresetChange (automatic activation along secondary axis)", () => {
      renderWithViewport();
      const iphoneRadio = document.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowDown" });

      expect(onViewportPresetChange).toHaveBeenCalledWith("pixel");
    });

    it("Home/End fire onViewportPresetChange for the new endpoint", () => {
      renderWithViewport();
      const pixelRadio = document.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;
      const galaxyRadio = document.querySelector(
        '[data-viewport-preset-id="galaxy"]'
      )! as HTMLElement;

      pixelRadio.focus();
      fireEvent.keyDown(pixelRadio, { key: "Home" });
      expect(onViewportPresetChange).toHaveBeenCalledWith("galaxy");

      onViewportPresetChange.mockClear();
      galaxyRadio.focus();
      fireEvent.keyDown(galaxyRadio, { key: "End" });
      expect(onViewportPresetChange).toHaveBeenCalledWith("ipad");
    });

    it("keyboard listener attaches after deferred chip row mount", () => {
      const onPresetChange = vi.fn();
      const { rerender, container } = render(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onPresetChange}
          viewportPreset={undefined}
        />
      );

      expect(container.querySelector('[role="radiogroup"]')).toBeNull();

      rerender(
        <BrowserToolbar
          {...defaultProps}
          onViewportPresetChange={onPresetChange}
          viewportPreset="iphone"
        />
      );

      const iphoneRadio = container.querySelector(
        '[data-viewport-preset-id="iphone"]'
      )! as HTMLElement;
      const pixelRadio = container.querySelector(
        '[data-viewport-preset-id="pixel"]'
      )! as HTMLElement;

      iphoneRadio.focus();
      fireEvent.keyDown(iphoneRadio, { key: "ArrowRight" });

      expect(document.activeElement).toBe(pixelRadio);
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
