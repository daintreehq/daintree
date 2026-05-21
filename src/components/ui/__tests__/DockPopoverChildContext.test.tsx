// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { DropdownMenuContent } from "../dropdown-menu";
import { primeRadix } from "../radix-loader";
import { DockPopoverChildProvider } from "../DockPopoverChildContext";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

function renderDropdown(wrapInProvider: boolean) {
  const tree = (
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
      <DropdownMenuContent forceMount>
        <span>item</span>
      </DropdownMenuContent>
    </DropdownMenuPrimitive.Root>
  );
  render(wrapInProvider ? <DockPopoverChildProvider>{tree}</DockPopoverChildProvider> : tree);
  return document.querySelector("[role='menu']") as HTMLElement;
}

describe("data-dock-popover-child stamping via DockPopoverChildProvider", () => {
  it("stamps the attribute on Radix content rendered inside the provider", () => {
    const content = renderDropdown(true);
    expect(content).not.toBeNull();
    expect(content.hasAttribute("data-dock-popover-child")).toBe(true);
  });

  it("omits the attribute when the same content renders outside the provider", () => {
    const content = renderDropdown(false);
    expect(content).not.toBeNull();
    expect(content.hasAttribute("data-dock-popover-child")).toBe(false);
  });

  it("the attribute is empty-string when present (matches `closest()` predicate)", () => {
    // `target.closest("[data-dock-popover-child]")` in dockPopoverGuard.ts
    // requires the attribute to be present, not value-equal. Confirm we
    // stamp an empty string rather than e.g. `"true"` so `closest` matches.
    const content = renderDropdown(true);
    expect(content.getAttribute("data-dock-popover-child")).toBe("");
  });
});
