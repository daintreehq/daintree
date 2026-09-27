// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/components/ui/ScrollShadow", () => ({
  ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import {
  AutocompleteMenu,
  autocompleteOptionId,
  getComboboxState,
  type AutocompleteItem,
} from "../AutocompleteMenu";

const noop = () => {};

describe("AutocompleteMenu", () => {
  it("returns nothing when isOpen is false", () => {
    const { container } = render(
      <AutocompleteMenu
        isOpen={false}
        items={[]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an empty-state status row when items are empty and not loading", () => {
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("No files match");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    // The listbox stays while the menu is open so the editor's aria-controls
    // names one element throughout; it simply has no options.
    expect(screen.getByRole("listbox").getAttribute("aria-label")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("does not render the empty status row when isLoading is true", () => {
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        isLoading={true}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );

    expect(screen.getByRole("status").textContent).toBe("Searching…");
  });

  it("renders listbox with options when items are present", () => {
    const items: AutocompleteItem[] = [
      { key: "a", label: "alpha", insertText: "alpha" },
      { key: "b", label: "beta", insertText: "beta" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("offers only the keys that will act on the selected row", () => {
    const run: AutocompleteItem = {
      key: "run",
      label: "/clear",
      insertText: "/clear",
      enterAction: "execute",
    };
    const insert: AutocompleteItem = {
      key: "ins",
      label: "/review",
      insertText: "/review",
      enterAction: "insert",
    };
    const hintText = (props: Partial<React.ComponentProps<typeof AutocompleteMenu>>) => {
      const { container, unmount } = render(
        <AutocompleteMenu
          isOpen={true}
          items={[run, insert]}
          selectedIndex={0}
          onSelect={noop}
          title="Commands"
          emptyMessage="No matches"
          {...props}
        />
      );
      const keys = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
      const header = container.querySelector("kbd")?.closest("[aria-hidden]")?.textContent ?? "";
      unmount();
      return { keys, header };
    };

    // A row Enter runs also completes on Tab, so both keys are named.
    expect(hintText({ selectedIndex: 0 }).header).toMatch(/run.*complete/);
    // A row Enter inserts names only the one action.
    const inserting = hintText({ selectedIndex: 1 });
    expect(inserting.header).toMatch(/insert/);
    expect(inserting.header).not.toMatch(/run/);
    // No promise while the keymap would refuse the row, or there is no row.
    expect(hintText({ staleKeys: new Set(["run"]) }).keys).toEqual([]);
    expect(hintText({ items: [], isLoading: true }).keys).toEqual([]);
    expect(hintText({ items: [] }).keys).toEqual([]);
  });

  it("speaks the key action on the row Enter acts on, and only there", () => {
    const items: AutocompleteItem[] = [
      { key: "run", label: "/clear", insertText: "/clear", enterAction: "execute" },
      { key: "ins", label: "/review", insertText: "/review", enterAction: "insert" },
    ];
    const { rerender } = render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        title="Commands"
        emptyMessage="No matches"
      />
    );
    const [first, second] = screen.getAllByRole("option");
    expect(first!.textContent).toMatch(/Enter to run, Tab to complete/);
    expect(second!.textContent).not.toMatch(/Enter to/);

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set(["run"])}
        onSelect={noop}
        title="Commands"
        emptyMessage="No matches"
      />
    );
    expect(screen.getAllByRole("option")[0]!.textContent).not.toMatch(/Enter to/);
  });

  it("gives each option a unique id the editor can name as its active descendant", () => {
    const items: AutocompleteItem[] = [
      { key: "a", label: "alpha", insertText: "alpha" },
      { key: "b", label: "beta", insertText: "beta" },
      { key: "c", label: "gamma", insertText: "gamma" },
    ];
    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={1}
        listboxId="menu-1"
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    const listbox = screen.getByRole("listbox");
    expect(listbox.id).toBe("menu-1");
    const options = screen.getAllByRole("option");
    expect(new Set(options.map((o) => o.id)).size).toBe(options.length);
    const selected = options.find((o) => o.getAttribute("aria-selected") === "true")!;
    expect(document.getElementById(autocompleteOptionId("menu-1", 1))).toBe(selected);
    // Reached through the editor's active descendant, never by tabbing.
    for (const option of options) expect(option.tabIndex).toBe(-1);
  });

  it("keeps one status region mounted across loading, results and no matches", () => {
    const items: AutocompleteItem[] = [{ key: "a", label: "alpha", insertText: "alpha" }];
    const { rerender } = render(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        isLoading={true}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Searching…");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={[]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No files match"
      />
    );
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("No files match");
  });

  it("leaves truncation to layout, so the whole description is in the row", () => {
    const description =
      "Clear conversation history but keep a summary in context. Optional: /compact [instructions]";
    render(
      <AutocompleteMenu
        isOpen={true}
        items={[{ key: "c", label: "/compact", insertText: "/compact", description }]}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("option").textContent).toContain(description);
  });

  it("marks the listbox busy while any row is stale or results are loading", () => {
    const items: AutocompleteItem[] = [{ key: "a", label: "alpha", insertText: "alpha" }];

    const { rerender } = render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set(["a"])}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set()}
        isLoading={true}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBe("true");

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set()}
        isLoading={false}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(screen.getByRole("listbox").getAttribute("aria-busy")).toBeNull();
  });

  it("never shows a stale row as the one Enter acts on, and says results are updating", () => {
    const items: AutocompleteItem[] = [
      { key: "a", label: "alpha", insertText: "alpha" },
      { key: "b", label: "beta", insertText: "beta" },
    ];
    const { rerender } = render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set(["a", "b"])}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    const selectedCount = () =>
      screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true")
        .length;
    expect(selectedCount()).toBe(0);
    expect(screen.getByRole("status").textContent).toMatch(/updating/i);

    rerender(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set()}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );
    expect(selectedCount()).toBe(1);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("marks only stale rows disabled and ignores clicks on them", () => {
    const onSelect = vi.fn();
    const items: AutocompleteItem[] = [
      { key: "fresh", label: "fresh", insertText: "fresh" },
      { key: "stale", label: "stale", insertText: "stale" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        staleKeys={new Set(["stale"])}
        onSelect={onSelect}
        emptyMessage="No matches"
      />
    );

    const options = screen.getAllByRole("option");
    const freshRow = options.find((o) => within(o).queryByText("fresh"))!;
    const staleRow = options.find((o) => within(o).queryByText("stale"))!;
    // Only the stale row is flagged disabled to assistive tech.
    expect(staleRow.getAttribute("aria-disabled")).toBe("true");
    expect(freshRow.getAttribute("aria-disabled")).toBeNull();

    // A click on a stale row is a no-op; a fresh row selects that exact item.
    staleRow.click();
    expect(onSelect).not.toHaveBeenCalled();
    freshRow.click();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("renders a neutral, screen-reader-labeled badge for skill, app, and plugin items", () => {
    const items: AutocompleteItem[] = [
      { key: "s", label: "/commit", insertText: "/commit", category: "skill" },
      { key: "a", label: "/connect", insertText: "/connect", category: "app" },
      { key: "p", label: "/gh", insertText: "/gh", category: "plugin" },
      { key: "c", label: "/help", insertText: "/help", category: "command" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    const options = screen.getAllByRole("option");
    const rowFor = (text: string) => options.find((o) => within(o).queryByText(text))!;

    // Each notable kind: visible badge hidden from AT, paired with an sr-only label.
    for (const [text, badge] of [
      ["/commit", "Skill"],
      ["/connect", "App"],
      ["/gh", "Plugin"],
    ] as const) {
      const row = rowFor(text);
      expect(within(row).getByText(badge, { selector: "[aria-hidden='true']" })).toBeTruthy();
      expect(within(row).getByText(`Category: ${badge}`)).toBeTruthy();
    }

    // Command row carries no badge — plain by design.
    const commandRow = rowFor("/help");
    expect(
      within(commandRow).queryByText("Skill", { selector: "[aria-hidden='true']" })
    ).toBeNull();
    expect(within(commandRow).queryByText(/Category:/)).toBeNull();
  });

  it("displays the label, not the insert token, when they differ", () => {
    const items: AutocompleteItem[] = [
      { key: "p", label: "Plugin Creator", insertText: "$plugin-creator", category: "plugin" },
    ];

    render(
      <AutocompleteMenu
        isOpen={true}
        items={items}
        selectedIndex={0}
        onSelect={noop}
        emptyMessage="No matches"
      />
    );

    const option = screen.getByRole("option");
    expect(within(option).getByText("Plugin Creator")).toBeTruthy();
    // The raw insert token must never surface in the row — the label is shown, not the token.
    expect(option.textContent).not.toContain("$plugin-creator");
  });

  it("scrolls to the selection on the first open, not only when it moves", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const items: AutocompleteItem[] = [
        { key: "a", label: "alpha", insertText: "alpha" },
        { key: "b", label: "beta", insertText: "beta" },
        { key: "c", label: "gamma", insertText: "gamma" },
      ];
      render(
        <AutocompleteMenu
          isOpen={true}
          items={items}
          selectedIndex={2}
          onSelect={noop}
          emptyMessage="No matches"
        />
      );
      const selected = screen
        .getAllByRole("option")
        .find((o) => o.getAttribute("aria-selected") === "true");
      expect(scrollSpy.mock.contexts).toContain(selected);
    } finally {
      if (original === undefined) {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Element.prototype.scrollIntoView = original;
      }
    }
  });

  it("scrolls the keyboard-selected option into view as selection moves", () => {
    const scrollSpy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;
    try {
      const items: AutocompleteItem[] = [
        { key: "a", label: "alpha", insertText: "alpha" },
        { key: "b", label: "beta", insertText: "beta" },
        { key: "c", label: "gamma", insertText: "gamma" },
      ];

      const { rerender } = render(
        <AutocompleteMenu
          isOpen={true}
          items={items}
          selectedIndex={0}
          onSelect={noop}
          emptyMessage="No matches"
        />
      );
      const callsAfterMount = scrollSpy.mock.calls.length;

      rerender(
        <AutocompleteMenu
          isOpen={true}
          items={items}
          selectedIndex={2}
          onSelect={noop}
          emptyMessage="No matches"
        />
      );

      expect(scrollSpy.mock.calls.length).toBeGreaterThan(callsAfterMount);
      expect(scrollSpy).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      if (original === undefined) {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      } else {
        Element.prototype.scrollIntoView = original;
      }
    }
  });

  describe("getComboboxState", () => {
    const items: AutocompleteItem[] = [
      { key: "a", label: "alpha", insertText: "alpha" },
      { key: "b", label: "beta", insertText: "beta" },
    ];
    const base = { items, selectedIndex: 1, staleKeys: new Set<string>(), listboxId: "lb" };

    it("reports expanded for as long as the menu is open, rows or not", () => {
      expect(getComboboxState({ ...base, isOpen: true }).expanded).toBe(true);
      expect(getComboboxState({ ...base, isOpen: true, items: [] }).expanded).toBe(true);
      expect(getComboboxState({ ...base, isOpen: false }).expanded).toBe(false);
    });

    it("names the selected option only when Enter would act on it", () => {
      expect(getComboboxState({ ...base, isOpen: true }).activeOptionId).toBe(
        autocompleteOptionId("lb", 1)
      );
      expect(
        getComboboxState({ ...base, isOpen: true, staleKeys: new Set(["b"]) }).activeOptionId
      ).toBeNull();
      expect(getComboboxState({ ...base, isOpen: true, items: [] }).activeOptionId).toBeNull();
      expect(getComboboxState({ ...base, isOpen: false }).activeOptionId).toBeNull();
    });
  });
});
