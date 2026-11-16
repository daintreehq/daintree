// @vitest-environment jsdom
// Its own file so its module cache starts cold: the launcher's palette loads on
// a hover, focus or open of its trigger and no sooner, and lives only while the
// launcher is open (#17034).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { primeRadix } from "@/components/ui/radix-loader";

const h = vi.hoisted(() => {
  let release: () => void = () => {};
  const chunk = new Promise<void>((resolve) => (release = resolve));
  return {
    chunk,
    release: () => release(),
    imported: vi.fn(),
    mounts: 0,
    unmounts: 0,
    focusOnMount: [] as boolean[],
  };
});

vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../ToolbarContextMenuItems", () => ({ ToolbarContextMenuItems: () => null }));

vi.mock("@/store/cliAvailabilityStore", () => {
  const state = {
    availability: { claude: "ready" },
    hasRealData: true,
    refresh: () => Promise.resolve(),
  };
  return {
    useCliAvailabilityStore: Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
      getState: () => state,
    }),
  };
});

vi.mock("@/hooks/app/useAgentDiscoveryOnboarding", () => {
  const onboarding = {
    loaded: true,
    seenAgentIds: [],
    availabilityFirstSeen: {},
    welcomeCardDismissed: true,
    markAgentsSeen: () => {},
    recordAgentFirstSeen: () => {},
  };
  return {
    NEW_AGENT_TTL_MS: 14 * 24 * 60 * 60 * 1000,
    useAgentDiscoveryOnboarding: () => onboarding,
  };
});

// Held back until the test lets the chunk land.
vi.mock("../DockLaunchPalette", async () => {
  h.imported();
  await h.chunk;
  const { useEffect } = await import("react");
  return {
    DockLaunchPalette: ({
      inputRef,
      focusOnMount,
    }: {
      inputRef: React.RefObject<HTMLInputElement | null>;
      focusOnMount: boolean;
    }) => {
      useEffect(() => {
        h.mounts += 1;
        h.focusOnMount.push(focusOnMount);
        return () => {
          h.unmounts += 1;
        };
      }, [focusOnMount]);
      return <input ref={inputRef} aria-label="Search agents, panels, and recipes" />;
    },
  };
});

const { DockLaunchButton, preloadDockLaunchPalette } = await import("../DockLaunchButton");

function launcher(placement: "dock" | "toolbar") {
  return (
    <DockLaunchButton
      agents={[{ id: "claude", name: "Claude", availability: "ready" }]}
      onLaunchAgent={() => {}}
      activeWorktreeId={null}
      cwd="/tmp"
      placement={placement}
    />
  );
}

const content = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
});

describe("dock launcher, cold (#17034)", () => {
  it("opens before its palette lands, then mounts it only while open", async () => {
    render(
      <>
        {launcher("toolbar")}
        {launcher("dock")}
      </>
    );
    // Two launchers drawn, neither opened or hovered: nothing loads, and the
    // toolbar's trigger still wears the discovery pip and says why.
    expect(h.imported).not.toHaveBeenCalled();
    const toolbarTrigger = screen.getByRole("button", { name: "Launcher — new agents detected" });
    expect(
      toolbarTrigger
        .querySelector('[data-testid="launcher-discovery-badge"]')
        ?.getAttribute("data-visible")
    ).toBe("true");

    // A hover starts the load and mounts nothing.
    await act(async () => {
      fireEvent.pointerEnter(toolbarTrigger);
    });
    expect(h.imported).toHaveBeenCalledTimes(1);
    expect(content()).toBeNull();
    expect(h.mounts).toBe(0);

    // The dock's launcher opens while that load is still in flight.
    const trigger = screen.getByRole("button", { name: "Open launcher" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(h.imported).toHaveBeenCalledTimes(1);
    const shell = content();
    if (shell === null) throw new Error("Missing launcher content");
    expect(shell.querySelector('[aria-busy="true"]')).not.toBeNull();
    // The modal content holds focus while the palette is still on its way.
    expect(shell.contains(document.activeElement)).toBe(true);

    await act(async () => {
      h.release();
      await preloadDockLaunchPalette();
    });
    await flush();
    expect(h.mounts).toBe(1);
    // Arrived after the content opened, so the palette takes focus itself.
    expect(h.focusOnMount).toEqual([true]);
    expect(shell.querySelector('[aria-busy="true"]')).toBeNull();

    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? shell, { key: "Escape" });
    });
    await flush();
    expect(content()).toBeNull();
    // A closed launcher keeps no palette mounted.
    expect(h.unmounts).toBe(1);
    expect(document.activeElement).toBe(trigger);

    // Warm now: a reopen draws the palette in the content's first commit, and
    // leaves focus to the content shell.
    await act(async () => {
      fireEvent.click(trigger);
    });
    expect(content()?.querySelector("input")).not.toBeNull();
    expect(h.focusOnMount).toEqual([true, false]);
    expect(h.imported).toHaveBeenCalledTimes(1);
  });
});
