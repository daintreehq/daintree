// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { PortalToolbar } from "../PortalToolbar";

const { dispatchMock, claimMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  claimMock: vi.fn(),
}));

vi.mock("@/hooks", () => ({
  useEffectiveCombo: () => undefined,
  useAriaKeyshortcuts: () => undefined,
  useOverlayClaim: claimMock,
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
  dispatchMock.mockReset();
  claimMock.mockReset();
});

function renderToolbar(onNewTab = vi.fn()) {
  render(
    <TooltipProvider>
      <PortalToolbar
        tabs={[{ id: "a", url: "https://claude.ai/", title: "Claude", icon: "claude" }]}
        activeTabId="a"
        onTabClick={vi.fn()}
        onTabClose={vi.fn()}
        onNewTab={onNewTab}
        defaultNewTabUrl={null}
        onClose={vi.fn()}
        enabledLinks={[
          {
            id: "claude",
            title: "Claude",
            url: "https://claude.ai/",
            icon: "claude",
            type: "system",
            enabled: true,
            order: 0,
          },
        ]}
      />
    </TooltipProvider>
  );
  return screen.getByRole("button", { name: "New Tab" });
}

describe("PortalToolbar new-tab menu", () => {
  it("opens as a React menu, the same system as the tab menus beside it", () => {
    const plus = renderToolbar();
    fireEvent.contextMenu(plus);
    const labels = Array.from(
      screen.getByRole("menu").querySelectorAll('[role="menuitem"]'),
      (item) => item.textContent
    );
    expect(labels).toEqual(["Claude", "Open launchpad", "Default new tab", "Portal settings…"]);
  });

  it("hides the native page while it is open so it is not painted underneath", () => {
    const plus = renderToolbar();
    fireEvent.contextMenu(plus);
    expect(claimMock).toHaveBeenCalledWith("portal-new-tab-menu", true);
  });

  it("opens links through the portal action", () => {
    const plus = renderToolbar();
    fireEvent.contextMenu(plus);
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude" }));
    expect(dispatchMock).toHaveBeenCalledWith(
      "portal.openUrl",
      { url: "https://claude.ai/", title: "Claude" },
      expect.objectContaining({ source: "context-menu" })
    );
  });

  it("keeps a plain click as new tab", () => {
    const onNewTab = vi.fn();
    fireEvent.click(renderToolbar(onNewTab));
    expect(onNewTab).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
