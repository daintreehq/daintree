// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Trash2, RotateCcw } from "lucide-react";
import { primeRadix } from "@/components/ui/radix-loader";
import { BannerOverflowMenu } from "../BannerOverflowMenu";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "More options" }), { key: "Enter" });
  return screen.getByRole("menu");
}

describe("BannerOverflowMenu", () => {
  it("opens the same menu every other overflow trigger opens", () => {
    const onRemove = vi.fn();
    render(
      <BannerOverflowMenu
        actions={[
          { id: "retry", label: "Retry with defaults", icon: RotateCcw, onClick: vi.fn() },
          {
            id: "remove",
            label: "Remove terminal",
            icon: Trash2,
            variant: "danger",
            onClick: onRemove,
          },
        ]}
      />
    );
    const menu = openMenu();
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      "Retry with defaults",
      "Remove terminal",
    ]);

    fireEvent.click(items[1]!);
    expect(onRemove).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks danger actions the way every destructive menu row is marked", () => {
    render(
      <BannerOverflowMenu
        actions={[
          { id: "safe", label: "Copy details", onClick: vi.fn() },
          { id: "danger", label: "Remove terminal", variant: "dangerFilled", onClick: vi.fn() },
        ]}
      />
    );
    const [safe, danger] = Array.from(openMenu().querySelectorAll('[role="menuitem"]'));
    expect(danger!.className).toContain("text-status-danger");
    expect(safe!.className).not.toContain("text-status-danger");
  });

  it("keeps a busy action visible but not selectable", () => {
    const onClick = vi.fn();
    render(
      <BannerOverflowMenu actions={[{ id: "busy", label: "Restarting", loading: true, onClick }]} />
    );
    const item = openMenu().querySelector('[role="menuitem"]')!;
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders nothing without overflow actions", () => {
    const { container } = render(<BannerOverflowMenu actions={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
