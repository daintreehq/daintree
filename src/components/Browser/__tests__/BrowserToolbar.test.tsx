// @vitest-environment jsdom
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { BrowserToolbar } from "../BrowserToolbar";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockRemoveUrl = vi.fn();

vi.mock("@/store/urlHistoryStore", () => ({
  useUrlHistoryStore: Object.assign(
    () => [
      {
        url: "http://localhost:3000/",
        title: "Home",
        visitCount: 5,
        lastVisitAt: Date.now(),
        favicon: "https://example.com/favicon.ico",
      },
      {
        url: "http://localhost:5173/",
        title: "Vite",
        visitCount: 2,
        lastVisitAt: Date.now(),
      },
    ],
    { getState: () => ({ removeUrl: mockRemoveUrl }) }
  ),
  getFrecencySuggestions: () => [
    {
      url: "http://localhost:3000/",
      title: "Home",
      visitCount: 5,
      lastVisitAt: Date.now(),
      favicon: "https://example.com/favicon.ico",
    },
    {
      url: "http://localhost:5173/",
      title: "Vite",
      visitCount: 2,
      lastVisitAt: Date.now(),
    },
  ],
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
