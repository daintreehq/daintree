// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalTab } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import type { CopyFlashTicket } from "@/lib/copyFlash";
import { PortalToolbar } from "../PortalToolbar";

const { claimMock } = vi.hoisted(() => ({ claimMock: vi.fn() }));

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: claimMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

const TABS: PortalTab[] = [
  { id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" },
  { id: "b", url: "https://chatgpt.com/", title: "ChatGPT", icon: "codex" },
  { id: "c", url: null, title: "New Tab" },
];

const mainWrite = vi.fn<(text: string) => Promise<void>>();
// The page holds focus, so the renderer's own clipboard refuses every write.
const rendererWrite = vi.fn(() =>
  Promise.reject(new DOMException("Document is not focused.", "NotAllowedError"))
);

function renderToolbar(
  props: Partial<React.ComponentProps<typeof PortalToolbar>> & { activeTabId: string | null }
) {
  return render(
    <TooltipProvider>
      <PortalToolbar
        tabs={TABS}
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={vi.fn()}
        defaultNewTabUrl={null}
        onClose={vi.fn()}
        enabledLinks={[]}
        {...props}
      />
    </TooltipProvider>
  );
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  claimMock.mockReset();
  mainWrite.mockReset().mockResolvedValue(undefined);
  rendererWrite.mockClear();
  Object.defineProperty(window, "electron", {
    value: { clipboard: { writeText: mainWrite } },
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: rendererWrite },
    configurable: true,
  });
});

afterEach(() => cleanup());

describe("PortalToolbar Copy URL", () => {
  it("copies the selected tab's URL through main and swaps to a check", async () => {
    renderToolbar({ activeTabId: "b", hasActiveUrl: true });
    const button = screen.getByRole("button", { name: "Copy URL" });
    expect(button.querySelector(".lucide-check")).toBeNull();

    fireEvent.click(button);

    await waitFor(() => expect(button.querySelector(".lucide-check")).not.toBeNull());
    expect(mainWrite).toHaveBeenCalledWith("https://chatgpt.com/");
    expect(rendererWrite).not.toHaveBeenCalled();
    // The name holds through the confirmation; the live region announces it.
    expect(button.getAttribute("aria-label")).toBe("Copy URL");
  });

  it("stays in the arrow order but inert while the selected tab has no page", () => {
    renderToolbar({ activeTabId: "c" });
    const button = screen.getByRole("button", { name: "Copy URL" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);

    const reload = screen.getByRole("button", { name: "Reload" });
    reload.focus();
    fireEvent.keyDown(reload, { key: "ArrowRight" });
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    expect(mainWrite).not.toHaveBeenCalled();
  });
});

describe("PortalToolbar tab menu Copy URL", () => {
  it("copies once the menu has let go of the page, confirming by the tab", async () => {
    const events: string[] = [];
    claimMock.mockImplementation((id: string, active: boolean) => {
      if (id === "portal-tab-menu-b") events.push(`claim:${active}`);
    });
    const onCopyTabUrl = vi.fn((_tabId: string, _flash: CopyFlashTicket) => {
      events.push("copy");
    });
    renderToolbar({ activeTabId: "a", onCopyTabUrl });
    const tab = screen.getByRole("tab", { name: "ChatGPT" });
    tab.getBoundingClientRect = () =>
      ({ left: 120, top: 80, right: 220, bottom: 112, width: 100, height: 32 }) as DOMRect;

    fireEvent.contextMenu(tab, { clientX: 140, clientY: 90 });
    // Released over the page area, which the page view covers once the menu
    // has closed.
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Copy URL" }), {
      clientX: 160,
      clientY: 400,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy URL" }));

    await waitFor(() => expect(onCopyTabUrl).toHaveBeenCalledOnce());
    const [tabId, flash] = onCopyTabUrl.mock.calls[0]!;
    expect(tabId).toBe("b");
    expect(flash.origin).toEqual({ kind: "rect", left: 120, top: 80, right: 220, bottom: 112 });
    expect(events.slice(0, events.indexOf("copy")).at(-1)).toBe("claim:false");
  });
});

describe("PortalToolbar All tabs", () => {
  let overflowing = true;

  beforeEach(() => {
    overflowing = true;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute("role") === "tablist" && overflowing ? 1000 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute("role") === "tablist" ? 200 : 0;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const allTabsClaim = () =>
    claimMock.mock.calls.filter(([id]) => id === "portal-all-tabs").at(-1)?.[1];

  function openAllTabs() {
    const trigger = screen.getByRole("button", { name: "All tabs (3)" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    return screen.getByRole("menu");
  }

  it("selects a tab only after the dropdown has released the page", async () => {
    const events: string[] = [];
    claimMock.mockImplementation((id: string, active: boolean) => {
      if (id === "portal-all-tabs") events.push(`claim:${active}`);
    });
    const onTabClick = vi.fn(() => {
      events.push("select");
    });
    renderToolbar({ activeTabId: "a", onTabClick });

    openAllTabs();
    expect(events.at(-1)).toBe("claim:true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ChatGPT" }));

    await waitFor(() => expect(onTabClick).toHaveBeenCalledWith("b"));
    expect(onTabClick).toHaveBeenCalledOnce();
    expect(events.slice(0, events.indexOf("select")).at(-1)).toBe("claim:false");
  });

  it("selects nothing when the dropdown is dismissed", async () => {
    const onTabClick = vi.fn();
    renderToolbar({ activeTabId: "a", onTabClick });

    const menu = openAllTabs();
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(allTabsClaim()).toBe(false);
    expect(onTabClick).not.toHaveBeenCalled();
  });

  it("releases the page when the strip stops overflowing under the open dropdown", () => {
    renderToolbar({ activeTabId: "a" });
    openAllTabs();
    expect(allTabsClaim()).toBe(true);

    // The open dropdown is modal, so it hides the strip from the a11y tree.
    const strip = screen.getByRole("tablist", { hidden: true });
    overflowing = false;
    act(() => {
      fireEvent.scroll(strip);
    });
    expect(screen.queryByRole("button", { name: "All tabs (3)" })).toBeNull();
    expect(allTabsClaim()).toBe(false);

    // The dropdown doesn't spring back open when the trigger returns.
    overflowing = true;
    act(() => {
      fireEvent.scroll(strip);
    });
    expect(screen.getByRole("button", { name: "All tabs (3)" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(allTabsClaim()).toBe(false);
  });
});
