// @vitest-environment jsdom
/**
 * Every tab in the app owns its right-click menu; the assistant's session
 * lanes had none. The lane under the pointer is the one the menu acts on.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HelpSessionTabs, type HelpSessionTab } from "../HelpSessionTabs";

const tabs: HelpSessionTab[] = [
  { slot: 1, label: "Session 1", agentState: "idle" },
  { slot: 2, label: "Session 2", agentState: "waiting" },
];

function renderStrip(props: { canOpenSession?: boolean; onAncestorContextMenu?: () => void }) {
  const onClose = vi.fn();
  const onOpenSession = vi.fn();
  render(
    <TooltipProvider>
      <div onContextMenu={props.onAncestorContextMenu}>
        <HelpSessionTabs
          tabs={tabs}
          activeSlot={1}
          onSelect={vi.fn()}
          onClose={onClose}
          canOpenSession={props.canOpenSession ?? true}
          onOpenSession={onOpenSession}
          idBase="help"
          panelId="help-body"
        />
      </div>
    </TooltipProvider>
  );
  return { onClose, onOpenSession };
}

function lane(slot: number): HTMLElement {
  return document.querySelector<HTMLElement>(`[role="tab"][data-slot="${slot}"]`)!;
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => cleanup());

describe("HelpSessionTabs — each lane owns its menu", () => {
  it("closes the lane under the pointer, not the active one", async () => {
    const { onClose } = renderStrip({});

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Close session" }));

    expect(onClose).toHaveBeenCalledWith(2);
    expect(onClose).not.toHaveBeenCalledWith(1);
  });

  it("offers a new session only while a lane is free", async () => {
    renderStrip({ canOpenSession: false });

    fireEvent.contextMenu(lane(1));
    const menu = await screen.findByRole("menu");

    const item = within(menu).getByRole("menuitem", { name: "New session" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the lane's right-click from reaching anything enclosing the strip", () => {
    const reached = vi.fn();
    renderStrip({ onAncestorContextMenu: reached });

    fireEvent.contextMenu(lane(2));

    expect(reached).not.toHaveBeenCalled();
  });

  it("hands focus to a surviving lane once a menu-closed lane is gone", async () => {
    function Strip() {
      const [open, setOpen] = useState(tabs);
      return (
        <TooltipProvider>
          <HelpSessionTabs
            tabs={open}
            activeSlot={1}
            onSelect={vi.fn()}
            onClose={(slot) => setOpen((all) => all.filter((t) => t.slot !== slot))}
            idBase="help"
            panelId="help-body"
          />
        </TooltipProvider>
      );
    }
    render(<Strip />);
    lane(2).focus();

    fireEvent.contextMenu(lane(2));
    const menu = await screen.findByRole("menu");
    await act(async () => {
      fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Close session" }), {
        key: "Enter",
      });
    });

    expect(lane(2)).toBeNull();
    expect(document.activeElement).toBe(lane(1));
  });
});
