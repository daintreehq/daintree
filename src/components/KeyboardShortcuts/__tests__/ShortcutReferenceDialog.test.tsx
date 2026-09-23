// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ShortcutReferenceDialog } from "../ShortcutReferenceDialog";
import type { RegisteredKeybindingConfig } from "@/services/KeybindingService";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
}));

type Binding = RegisteredKeybindingConfig & { effectiveCombo: string };

function binding(
  actionId: string,
  description: string,
  category: string,
  effectiveCombo: string,
  scope: Binding["scope"] = "global"
): Binding {
  return {
    actionId: actionId as Binding["actionId"],
    combo: effectiveCombo,
    scope,
    priority: 0,
    description,
    category,
    effectiveCombo,
  };
}

let mockBindings: Binding[] = [];
let mockOverrides = new Set<string>();

function seed(): void {
  mockBindings = [
    binding("terminal.new", "New terminal", "Terminal", "Cmd+Alt+T"),
    binding("terminal.close", "Close focused terminal", "Terminal", "Cmd+W"),
    binding("terminal.close", "Close focused terminal", "Terminal", "Ctrl+F4"),
    binding("terminal.stashInput", "Stash current input", "Terminal", "Cmd+Shift+S"),
    binding("terminal.restartAll", "Restart all terminals", "Terminal", "Cmd+K Cmd+A"),
    binding("terminal.redraw", "Redraw focused terminal", "Terminal", ""),
    ...[1, 2, 3, 4].map((n) =>
      binding(`terminal.focusIndex${n}`, `Focus terminal ${n}`, "Terminal", `Cmd+${n}`)
    ),
    binding("agent.claude", "Launch Claude Code agent", "Agents", "Cmd+Alt+C"),
    binding(
      "terminal.sendToAgent",
      "Send selection to another terminal",
      "Terminal",
      "Cmd+Shift+E"
    ),
    binding("action.palette.open", "Open command palette", "Navigation", "Cmd+Shift+P"),
    binding("nav.toggleSidebar", "Toggle sidebar", "Navigation", "Cmd+B"),
    binding("help.shortcuts", "Open keyboard shortcuts reference", "Help", "Cmd+K Cmd+S"),
    binding("help.shortcutsAlt", "Open keyboard shortcuts reference", "Help", "Cmd+/"),
    binding("portal.closeTab", "Close active portal tab", "Portal", "Cmd+W", "portal"),
    binding("portal.newTab", "New portal tab", "Portal", "Cmd+T", "portal"),
    binding("app.settings", "Open settings", "System", "Cmd+,"),
    binding("plugin.thing", "Do the plugin thing", "Acme plugin", "Cmd+Alt+Y"),
  ];
  mockOverrides = new Set(["terminal.redraw", "terminal.stashInput"]);
}

vi.mock("@/services/KeybindingService", () => {
  const listeners: Array<() => void> = [];
  return {
    keybindingService: {
      getAllBindingsWithEffectiveCombos: vi.fn(() => mockBindings),
      hasOverride: vi.fn((actionId: string) => mockOverrides.has(actionId)),
      subscribe: vi.fn((listener: () => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index > -1) listeners.splice(index, 1);
        };
      }),
      notifyListeners: () => listeners.forEach((l) => l()),
    },
  };
});

function search(): HTMLInputElement {
  return screen.getByLabelText("Search shortcuts") as HTMLInputElement;
}

function type(value: string): void {
  fireEvent.change(search(), { target: { value } });
}

function rowNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.firstElementChild?.firstChild?.textContent ?? "");
}

function rowFor(name: string): HTMLElement {
  const row = screen.getAllByRole("listitem").find((el) => el.textContent?.startsWith(name));
  if (!row) throw new Error(`no row named ${name}`);
  return row;
}

function countRegion(): HTMLElement {
  return screen.getAllByRole("status").find((el) => el.textContent?.includes("shortcut"))!;
}

describe("ShortcutReferenceDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  describe("opening", () => {
    it("puts focus in the search field once the dialog has settled", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      expect(document.activeElement).toBe(search());
    });

    it("starts every opening with an empty query", async () => {
      const { rerender } = render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("zzqx");
      expect(search().value).toBe("zzqx");

      rerender(<ShortcutReferenceDialog isOpen={false} onClose={vi.fn()} />);
      rerender(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);

      await waitFor(() => expect(search().value).toBe(""));
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    });
  });

  describe("browsing", () => {
    it("orders categories by the shared browse order, with unknown ones last", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
      const names = headings.map((h) => h?.replace(/In the portal$/, "") ?? "");
      expect(names.indexOf("Navigation")).toBeLessThan(names.indexOf("Terminal"));
      expect(names.indexOf("Terminal")).toBeLessThan(names.indexOf("Help"));
      expect(names[names.length - 1]).toBe("Acme plugin");
    });

    it("shows an action bound twice as one row carrying both keys", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      const rows = rowNames().filter((name) => name === "Close focused terminal");
      expect(rows).toHaveLength(1);
      const spoken = rowFor("Close focused terminal").querySelector(".sr-only")!.textContent!;
      expect(spoken).toMatch(/Command W, or Control F4/);
    });

    it("merges two actions that are described identically in one category", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      expect(rowNames().filter((n) => n === "Open keyboard shortcuts reference")).toHaveLength(1);
    });

    it("folds a numbered family into one row", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      const names = rowNames();
      expect(names.filter((n) => n.startsWith("Focus terminal"))).toEqual(["Focus terminal 1–4"]);
    });

    it("states a scope once on the heading when a whole category shares it", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      const heading = screen
        .getAllByRole("heading", { level: 3 })
        .find((h) => h.textContent?.startsWith("Portal"))!;
      expect(heading.textContent).toMatch(/In the portal/);
      expect(rowFor("New portal tab").textContent).not.toMatch(/In the portal/);
    });

    it("marks customised rows, and only those, as custom", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      for (const row of screen.getAllByRole("listitem")) {
        const name = row.firstElementChild?.firstChild?.textContent ?? "";
        const custom = name === "Redraw focused terminal" || name === "Stash current input";
        expect(row.textContent?.includes("Custom"), name).toBe(custom);
      }
    });

    it("says an unbound action is not set rather than leaving the column blank", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      expect(rowFor("Redraw focused terminal").textContent).toMatch(/Not set/);
    });

    it("never gives assistive tech a modifier glyph to read", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      for (const row of screen.getAllByRole("listitem")) {
        const spoken = row.querySelector(".sr-only")?.textContent ?? "";
        expect(spoken, row.textContent ?? "").not.toMatch(/[⌘⌥⇧⌃]/);
        for (const kbd of row.querySelectorAll("kbd")) {
          expect(kbd.closest('[aria-hidden="true"]')).toBeTruthy();
        }
      }
    });

    it("uses list/listitem roles for shortcut rows", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      expect(screen.getAllByRole("list").length).toBeGreaterThan(0);
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    });
  });

  describe("searching", () => {
    it("ranks a word match above a near miss from an earlier category", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("agent");
      await waitFor(() => expect(rowNames()[0]).toBe("Launch Claude Code agent"));
      expect(rowNames()).not.toContain("Send selection to another terminal");
    });

    it("labels each result with its category, since results lose their headings", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("agent");
      await waitFor(() => expect(rowFor("Launch Claude Code agent").textContent).toMatch(/Agents/));
      expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    });

    it("filters to a chord family by key prefix, in glyphs or words", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      for (const query of ["cmd+k", "⌘k", "cmd k"]) {
        type(query);
        await waitFor(() => expect(rowNames()).toContain("Restart all terminals"));
        expect(rowNames(), query).not.toContain("Toggle sidebar");
      }
    });

    it("finds an alternative key, not only the first one", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("⌘/");
      await waitFor(() => expect(rowNames()).toContain("Open keyboard shortcuts reference"));
    });

    it("lists every key using a lone modifier", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("cmd");
      await waitFor(() => expect(rowNames()).toContain("Toggle sidebar"));
      expect(rowNames()).not.toContain("Redraw focused terminal");
    });

    it("falls back to fuzzy matching for a misspelling", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("stsh");
      await waitFor(() => expect(rowNames()).toContain("Stash current input"));
    });

    it("offers a way out of an empty result and returns focus to the search", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      type("zzqx");
      const clear = await screen.findByRole("button", { name: "Clear search" });
      expect(screen.getByText(/No shortcuts match/, { selector: "p" })).toBeTruthy();
      fireEvent.click(clear);
      expect(search().value).toBe("");
      expect(document.activeElement).toBe(search());
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    });
  });

  describe("announcements", () => {
    it("keeps a single polite, atomic count region mounted through every state", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      expect(countRegion().getAttribute("aria-live")).toBe("polite");
      expect(countRegion().getAttribute("aria-atomic")).toBe("true");

      type("zzqx");
      await waitFor(() => expect(countRegion().textContent).toMatch(/No shortcuts match "zzqx"/));
      expect(screen.getAllByRole("status")).toHaveLength(1);
    });

    it("counts the rows the user sees, and re-announces a same-count change", async () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      expect(countRegion().textContent).toBe(`${screen.getAllByRole("listitem").length} shortcuts`);

      type("settings");
      await waitFor(() =>
        expect(countRegion().textContent).toBe('1 shortcut found for "settings"')
      );
      type("sidebar");
      await waitFor(() => expect(countRegion().textContent).toBe('1 shortcut found for "sidebar"'));
    });

    it("links the search field to the results it controls", () => {
      render(<ShortcutReferenceDialog isOpen={true} onClose={vi.fn()} />);
      const controlsId = search().getAttribute("aria-controls");
      expect(controlsId && document.getElementById(controlsId)).toBeTruthy();
    });
  });

  it("hands off to the Settings keyboard page and closes", () => {
    const onClose = vi.fn();
    const details: unknown[] = [];
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) details.push(event.detail);
    };
    window.addEventListener("daintree:open-settings-tab", listener);
    render(<ShortcutReferenceDialog isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit shortcuts" }));

    expect(onClose).toHaveBeenCalled();
    expect(details).toEqual([{ tab: "keyboard" }]);
    window.removeEventListener("daintree:open-settings-tab", listener);
  });
});
