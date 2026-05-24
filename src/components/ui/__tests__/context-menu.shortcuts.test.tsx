// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { ContextMenuActionItem } from "../context-menu";
import { primeRadix } from "../radix-loader";
import { keybindingService } from "@/services/KeybindingService";
import type { ActionId } from "@shared/types/actions";

// `useAriaKeyshortcuts` reads `navigator.platform` via `isMac()` to pick the
// ARIA modifier table (Meta on mac, Control elsewhere). Pin Linux so the
// expected value is deterministic across runners.
const ORIGINAL_PLATFORM = globalThis.navigator?.platform;

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { ...globalThis.navigator, platform },
    configurable: true,
    writable: true,
  });
}

// Synthetic actionIds + an unused combo so we don't collide with any
// built-in binding (which would make `registerBinding` skip the registration
// with a console warning).
const TEST_ACTION_BOUND = "test.shortcuts.contextMenu.bound" as ActionId;
const TEST_ACTION_UNBOUND = "test.shortcuts.contextMenu.unbound" as ActionId;
const TEST_COMBO = "Cmd+Alt+Shift+F12"; // unlikely to clash with defaults

beforeAll(async () => {
  await primeRadix();
  setPlatform("Linux x86_64");
  keybindingService.registerBinding({
    actionId: TEST_ACTION_BOUND,
    combo: TEST_COMBO,
    scope: "global",
    priority: 0,
  });
});

afterAll(() => {
  keybindingService.removeBinding(TEST_ACTION_BOUND);
  if (ORIGINAL_PLATFORM !== undefined) {
    setPlatform(ORIGINAL_PLATFORM);
  }
});

afterEach(cleanup);

function renderActionItem(actionId: ActionId): HTMLElement {
  const { container } = render(
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger data-testid="trigger">trigger</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content forceMount>
          <ContextMenuActionItem actionId={actionId}>Test Item</ContextMenuActionItem>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );

  // Context menus open in response to a contextmenu event on the trigger;
  // Radix has no `open`/`defaultOpen` on the root, so fire the gesture to
  // mount the Item content into the portal.
  const trigger = container.querySelector("[data-testid='trigger']") as HTMLElement | null;
  if (!trigger) throw new Error("Trigger not found");
  fireEvent.contextMenu(trigger);

  const item = document.querySelector("[role='menuitem']") as HTMLElement | null;
  if (!item) throw new Error("Failed to render ContextMenuActionItem");
  return item;
}

describe("ContextMenuActionItem aria-keyshortcuts — issue #8941", () => {
  it("renders aria-keyshortcuts in canonical ARIA form for a bound action", () => {
    const item = renderActionItem(TEST_ACTION_BOUND);
    // On Linux, `Cmd+` is rewritten to `Control+` for ARIA so the attribute
    // matches the physical key the user actually presses.
    expect(item.getAttribute("aria-keyshortcuts")).toBe("Control+Alt+Shift+F12");
  });

  it("omits aria-keyshortcuts entirely when no binding is registered", () => {
    const item = renderActionItem(TEST_ACTION_UNBOUND);
    // `useAriaKeyshortcuts` returns `undefined` for unbound actions; React
    // must not render the attribute in that case (rendering an empty string
    // would mislead screen readers).
    expect(item.hasAttribute("aria-keyshortcuts")).toBe(false);
  });
});
