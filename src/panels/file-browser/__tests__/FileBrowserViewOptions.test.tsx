// @vitest-environment jsdom
import { createContext, useContext, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FileBrowserSortOrder, HiddenRowCounts } from "../fileBrowserTree";
import { NO_HIDDEN_ROWS } from "../fileBrowserTree";

// Radix opens its menu on a pointer sequence and portals the content, neither of
// which jsdom drives faithfully. Render the items inline and let them fire their
// own callbacks — what this suite owns is the payload each item hands back, not
// Radix's open/close choreography. Same shape as the mock in
// FileBrowserViewer.test.tsx, where these assertions used to live.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
    >
      {children}
    </button>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
    "data-testid": testId,
  }: {
    children: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => {
        onCheckedChange(!checked);
      }}
    >
      {children}
    </button>
  ),
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => (
    <RadioGroupContext.Provider value={onValueChange}>
      <div data-value={value}>{children}</div>
    </RadioGroupContext.Provider>
  ),
  DropdownMenuRadioItem: ({ children, value }: { children: ReactNode; value: string }) => {
    const onValueChange = useContext(RadioGroupContext);
    return (
      <div role="menuitemradio" onClick={() => onValueChange?.(value)}>
        {children}
      </div>
    );
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Context, not a module-level stash: there are two radio groups (key and
// direction), and a single shared handler would route every click to whichever
// group rendered last — passing the tests for the wrong reason.
const RadioGroupContext = createContext<((value: string) => void) | null>(null);

const { FileBrowserViewOptions } = await import("../FileBrowserViewOptions");

function renderMenu(
  overrides: {
    sort?: FileBrowserSortOrder;
    onSortChange?: (next: FileBrowserSortOrder) => void;
    hideDotfiles?: boolean;
    onHideDotfilesChange?: (hide: boolean) => void;
    hiddenCounts?: HiddenRowCounts;
  } = {}
) {
  return render(
    <FileBrowserViewOptions
      sort={overrides.sort ?? { key: "name", direction: "asc" }}
      onSortChange={overrides.onSortChange ?? vi.fn()}
      hideDotfiles={overrides.hideDotfiles ?? false}
      onHideDotfilesChange={overrides.onHideDotfilesChange ?? vi.fn()}
      hiddenCounts={overrides.hiddenCounts ?? NO_HIDDEN_ROWS}
      onRefresh={vi.fn()}
      isRefreshing={false}
      onCollapseAll={vi.fn()}
      canCollapseAll={false}
    />
  );
}

afterEach(cleanup);

// Re-homed from the `sort menu (#11620)` suite in FileBrowserViewer.test.tsx:
// the sort menu was consolidated into this component, and the contract each
// item's payload has to honour moved with it.
describe("FileBrowserViewOptions sort menu", () => {
  it("changes the key without disturbing the direction", () => {
    const onSortChange = vi.fn();
    renderMenu({ sort: { key: "name", direction: "desc" }, onSortChange });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }));

    expect(onSortChange).toHaveBeenCalledWith({ key: "size", direction: "desc" });
  });

  it("changes the direction without disturbing the key", () => {
    const onSortChange = vi.fn();
    renderMenu({ sort: { key: "modified", direction: "asc" }, onSortChange });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Descending" }));

    expect(onSortChange).toHaveBeenCalledWith({ key: "modified", direction: "desc" });
  });

  it("can set a direction outright rather than only reversing the current one", () => {
    // The reason this is a radio group and not a re-pick-to-flip gesture:
    // choosing the direction already in effect is a no-op the user can rely on,
    // not a silent reversal.
    const onSortChange = vi.fn();
    renderMenu({ sort: { key: "name", direction: "asc" }, onSortChange });

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ascending" }));

    expect(onSortChange).toHaveBeenCalledWith({ key: "name", direction: "asc" });
  });

  it("offers the four documented keys and both directions", () => {
    renderMenu();

    const names = screen.getAllByRole("menuitemradio").map((item) => item.textContent?.trim());

    expect(names).toEqual(["Name", "Modified", "Size", "Type", "Ascending", "Descending"]);
  });
});

describe("FileBrowserViewOptions dotfile filter", () => {
  it("checks the row when dotfiles are shown, since the label reads positively", () => {
    // The prop is `hideDotfiles` and the row says "Show dotfiles", so the two
    // run opposite ways. Reading the checked state back is what proves the
    // inversion below is a real flip and not a pass-through.
    renderMenu({ hideDotfiles: false });

    expect(screen.getByTestId("file-browser-show-dotfiles").getAttribute("aria-checked")).toBe(
      "true"
    );
  });

  it("asks to hide dotfiles when the row is unchecked", () => {
    const onHideDotfilesChange = vi.fn();
    renderMenu({ hideDotfiles: false, onHideDotfilesChange });

    fireEvent.click(screen.getByTestId("file-browser-show-dotfiles"));

    expect(onHideDotfilesChange).toHaveBeenCalledWith(true);
  });

  it("asks to show them again when the row is checked back on", () => {
    const onHideDotfilesChange = vi.fn();
    renderMenu({ hideDotfiles: true, onHideDotfilesChange });

    expect(screen.getByTestId("file-browser-show-dotfiles").getAttribute("aria-checked")).toBe(
      "false"
    );
    fireEvent.click(screen.getByTestId("file-browser-show-dotfiles"));

    expect(onHideDotfilesChange).toHaveBeenCalledWith(false);
  });

  it("shows the dotfile count on the row only while the filter is removing rows", () => {
    const { rerender } = renderMenu({ hiddenCounts: { dotfiles: 0, alwaysHidden: 3 } });
    // alwaysHidden is the Settings junk list, which this row cannot recover, so
    // it must not leak into the number beside a control that only governs
    // dotfiles.
    expect(screen.getByTestId("file-browser-show-dotfiles").textContent?.trim()).toBe(
      "Show dotfiles"
    );

    rerender(
      <FileBrowserViewOptions
        sort={{ key: "name", direction: "asc" }}
        onSortChange={vi.fn()}
        hideDotfiles
        onHideDotfilesChange={vi.fn()}
        hiddenCounts={{ dotfiles: 4, alwaysHidden: 3 }}
        onRefresh={vi.fn()}
        isRefreshing={false}
        onCollapseAll={vi.fn()}
        canCollapseAll={false}
      />
    );

    expect(screen.getByTestId("file-browser-show-dotfiles").textContent).toContain("4");
  });
});
