// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real loader and the real Radix chunk, with the chunk's arrival held
// behind a gate. This is the cold-start window the deferred wrappers exist
// for: a trigger is on screen and interactive before its Radix primitive has
// loaded, and the user's first gesture must not be lost to that race.
//
// vitest.setup.ts primes the loader for every jsdom file, so each case resets
// the module graph and re-imports it to get a loader that has not loaded Radix
// yet (Testing Library included, so it renders with the same React copy). Each
// case also gets its own closed gate, so every case stands alone.
const gate = vi.hoisted(() => {
  const state = { opened: Promise.resolve(), release: () => {} };
  return {
    state,
    reset() {
      state.opened = new Promise<void>((resolve) => {
        state.release = resolve;
      });
    },
  };
});

vi.mock("../radix-deferred", async (importOriginal) => {
  await gate.state.opened;
  return importOriginal();
});

let rtl: typeof import("@testing-library/react");
let menu: typeof import("../dropdown-menu");
let tooltip: typeof import("../tooltip");
let loader: typeof import("../radix-loader");

beforeEach(async () => {
  gate.reset();
  vi.resetModules();
  rtl = await import("@testing-library/react");
  menu = await import("../dropdown-menu");
  tooltip = await import("../tooltip");
  loader = await import("../radix-loader");
});

afterEach(() => {
  rtl.cleanup();
  gate.state.release();
});

async function loadChunk(): Promise<void> {
  await rtl.act(async () => {
    gate.state.release();
    await loader.primeRadix();
  });
}

function Menu({ label }: { label: string }) {
  const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } = menu;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>{label}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename {label}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Hint({ label }: { label: string }) {
  const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } = tooltip;
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">{label}</button>
        </TooltipTrigger>
        <TooltipContent>Hint for {label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]');
}

function openTooltip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="tooltip"]');
}

describe("deferred Radix dropdown on first interaction", () => {
  it("a click made before the chunk loads opens the menu once it arrives", async () => {
    const { fireEvent, render, waitFor } = rtl;
    const { getByRole } = render(<Menu label="Cold" />);
    const trigger = getByRole("button", { name: "Cold" });

    expect(loader.getRadixPrimitives()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(openMenu()).toBeNull();

    await loadChunk();

    await waitFor(() => {
      expect(openMenu()?.textContent).toContain("Rename Cold");
    });
    expect(loader.getRadixPrimitives()).not.toBeNull();
    // The open modal menu aria-hides the rest of the page, trigger included.
    const upgraded = getByRole("button", { name: "Cold", hidden: true });
    expect(upgraded.getAttribute("aria-expanded")).toBe("true");
  });

  it("after the chunk loads, the first pointer press on a fresh trigger opens its menu", async () => {
    const { fireEvent, render, waitFor } = rtl;
    await loadChunk();
    expect(loader.getRadixPrimitives()).not.toBeNull();

    const { getByRole } = render(<Menu label="Warm" />);
    const trigger = getByRole("button", { name: "Warm" });
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(openMenu()).toBeNull();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    await waitFor(() => {
      expect(openMenu()?.textContent).toContain("Rename Warm");
    });
    expect(trigger.getAttribute("data-state")).toBe("open");
  });
});

describe("deferred Radix tooltip on first interaction", () => {
  it("a trigger focused before the chunk loads is upgraded and focus opens its tooltip", async () => {
    const { render, waitFor } = rtl;
    const { getByRole } = render(<Hint label="Settings" />);
    const plain = getByRole("button", { name: "Settings" });

    expect(loader.getRadixPrimitives()).toBeNull();
    expect(plain.hasAttribute("data-state")).toBe(false);

    // Focus alone primes the chunk through the trigger's focus-capture handler.
    plain.focus();
    expect(document.activeElement).toBe(plain);

    await loadChunk();

    // `data-state` only exists on the Radix trigger, so it proves the upgrade.
    await waitFor(() => {
      expect(getByRole("button", { name: "Settings" }).getAttribute("data-state")).toBe("closed");
    });
    // The upgrade remounts the trigger, so focus taken before the chunk loaded
    // does not survive it (see the todo below). Refocus to test the tooltip.
    const upgraded = getByRole("button", { name: "Settings" });
    upgraded.blur();
    upgraded.focus();
    expect(document.activeElement).toBe(upgraded);
    await waitFor(() => {
      expect(openTooltip()?.textContent).toContain("Hint for Settings");
    });
  });

  it.todo("keeps focus on a trigger that was focused before the chunk loaded");

  it("after the chunk loads, the first hover on a fresh trigger opens its tooltip", async () => {
    const { fireEvent, render, waitFor } = rtl;
    await loadChunk();

    const { getByRole } = render(<Hint label="Terminal" />);
    const trigger = getByRole("button", { name: "Terminal" });
    expect(trigger.getAttribute("data-state")).toBe("closed");
    expect(openTooltip()).toBeNull();

    fireEvent.pointerMove(trigger, { pointerType: "mouse" });

    await waitFor(() => {
      expect(openTooltip()?.textContent).toContain("Hint for Terminal");
    });
  });
});
