// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { DropdownMenuItem } from "../dropdown-menu";

afterEach(cleanup);

function renderItem(props: React.ComponentProps<typeof DropdownMenuItem>) {
  render(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content forceMount>
          <DropdownMenuItem {...props}>Test Item</DropdownMenuItem>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
  return document.querySelector("[role='menuitem']") as HTMLElement;
}

describe("DropdownMenuItem destructive variant", () => {
  it("applies danger classes when destructive is true", () => {
    const item = renderItem({ destructive: true });
    expect(item.className).toContain("text-status-danger");
    expect(item.className).toContain("data-[highlighted]:text-status-danger");
    expect(item.className).toContain("data-[highlighted]:bg-status-danger/10");
  });

  it("does not apply danger classes by default", () => {
    const item = renderItem({});
    expect(item.className).not.toContain("text-status-danger");
    expect(item.className).not.toContain("bg-status-danger");
  });

  it("does not forward destructive as a DOM attribute", () => {
    const item = renderItem({ destructive: true });
    expect(item.hasAttribute("destructive")).toBe(false);
  });
});
