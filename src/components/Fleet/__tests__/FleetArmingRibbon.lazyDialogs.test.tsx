// @vitest-environment jsdom
// Its own file: a module loads once per file, so whether the ribbon loads its
// dialogs can only be seen before anything in the file has opened one.
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const loadedFleetDialogs = vi.hoisted(() => ({ save: false, manage: false }));

vi.mock("../SaveFleetDialog", async (importOriginal) => {
  loadedFleetDialogs.save = true;
  return importOriginal();
});

vi.mock("../SavedFleetsDialog", async (importOriginal) => {
  loadedFleetDialogs.manage = true;
  return importOriginal();
});

vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => (
      <div ref={ref} {...props}>
        {children}
      </div>
    )
  );
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
    domAnimation: {},
    domMax: {},
    m: { div: MotionDiv },
    motion: { div: MotionDiv },
    useReducedMotion: () => false,
  };
});

vi.mock("@/hooks/useWorktreeColorMap", () => ({
  useWorktreeColorMap: () => null,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

// The menu's content always renders; a button stands in for opening it.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuMeta: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <>
      <button type="button" data-testid="open-selection-menu" onClick={() => onOpenChange?.(true)}>
        Open menu
      </button>
      {children}
    </>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <div role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </div>
  ),
  DropdownMenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { FleetArmingRibbon } from "../FleetArmingRibbon";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

describe("FleetArmingRibbon — fleet dialogs load on demand (#16799)", () => {
  it("loads neither dialog for an idle or armed ribbon, and both once its menu opens", async () => {
    render(<FleetArmingRibbon />);
    act(() => useFleetArmingStore.getState().armIds(["a", "b"]));
    expect(screen.getByTestId("fleet-selection-menu-trigger")).toBeTruthy();
    expect(loadedFleetDialogs).toEqual({ save: false, manage: false });

    fireEvent.click(screen.getByTestId("open-selection-menu"));
    await waitFor(() => expect(loadedFleetDialogs).toEqual({ save: true, manage: true }));
    // Loaded is not opened: neither dialog shows until it is asked for.
    expect(screen.queryByTestId("fleet-save-dialog")).toBeNull();
    expect(screen.queryByTestId("fleet-saved-manage-dialog")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText("Save as fleet…"));
    });
    expect(await screen.findByTestId("fleet-save-dialog")).toBeTruthy();
  });
});
