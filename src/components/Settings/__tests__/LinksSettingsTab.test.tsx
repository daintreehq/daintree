// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyPayload } from "@/lib/notify";

const tabHasError = vi.hoisted(() => ({ current: false }));
vi.mock("../SettingsValidationRegistry", () => ({
  useSettingsTabValidation: (_tab: string, hasError: boolean) => {
    tabHasError.current = hasError;
  },
}));
const mockNotify = vi.fn<(payload: NotifyPayload) => void>();
vi.mock("@/lib/notify", () => ({
  notify: (payload: NotifyPayload) => mockNotify(payload),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { isTooltipSuppressedForElement } from "@/lib/tooltipFocusSuppression";
import { useGlobalLinksStore, type GlobalLink } from "@/store/globalLinksStore";
import { LinksSettingsTab } from "../LinksSettingsTab";

function link(id: string, order: number, extra: Partial<GlobalLink> = {}): GlobalLink {
  return {
    id,
    title: id[0]!.toUpperCase() + id.slice(1),
    url: `https://${id}.example.com/`,
    icon: "globe",
    enabled: true,
    order,
    ...extra,
  };
}

const DOCS = link("docs", 0, { title: "Team docs" });
const WIKI = link("wiki", 1);
const CI = link("ci", 2, { title: "CI" });

function renderTab() {
  return render(
    <TooltipProvider>
      <LinksSettingsTab />
    </TooltipProvider>
  );
}

function titles(): string[] {
  return useGlobalLinksStore.getState().links.map((l) => l.title);
}

function stored(id: string): GlobalLink | undefined {
  return useGlobalLinksStore.getState().links.find((l) => l.id === id);
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function switchFor(name: string): HTMLButtonElement {
  return screen.getByRole("switch", { name }) as HTMLButtonElement;
}

/** The text an element's aria-describedby actually resolves to. */
function describedText(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** The Undo the latest removal offered. */
function lastUndo(): () => void {
  const payload = mockNotify.mock.calls.at(-1)?.[0];
  const onClick = payload?.action?.onClick;
  if (!onClick) throw new Error("no Undo was offered");
  return () => act(() => void onClick());
}

beforeEach(() => {
  mockNotify.mockReset();
  tabHasError.current = false;
  // Clears the persistence adapter's bookkeeping too, not only the stored bytes.
  void useGlobalLinksStore.persist.clearStorage();
  localStorage.clear();
  useGlobalLinksStore.setState({ links: [DOCS, WIKI, CI] });
});

describe("LinksSettingsTab adding a link", () => {
  it("adds it after the others, trimmed, and readies the form for the next one", () => {
    useGlobalLinksStore.setState({ links: [DOCS] });
    renderTab();
    const name = screen.getByRole("textbox", { name: "New link name" }) as HTMLInputElement;
    const url = screen.getByRole("textbox", { name: "New link URL" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "  Linear " } });
    fireEvent.change(url, { target: { value: " https://linear.app " } });
    fireEvent.keyDown(url, { key: "Enter" });

    const links = useGlobalLinksStore.getState().links;
    expect(links.map((l) => [l.title, l.url, l.enabled])).toEqual([
      ["Team docs", DOCS.url, true],
      ["Linear", "https://linear.app", true],
    ]);
    expect(name.value).toBe("");
    expect(url.value).toBe("");
    expect(document.activeElement).toBe(name);
    expect(button("Edit Linear")).toBeTruthy();
  });

  it("adds from the Add button as well as Enter in either field", () => {
    useGlobalLinksStore.setState({ links: [] });
    renderTab();
    const name = screen.getByRole("textbox", { name: "New link name" });
    const url = screen.getByRole("textbox", { name: "New link URL" });
    fireEvent.change(name, { target: { value: "Status" } });
    fireEvent.change(url, { target: { value: "https://status.example.com" } });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.change(name, { target: { value: "Board" } });
    fireEvent.change(url, { target: { value: "https://board.example.com" } });
    fireEvent.click(button("Add"));

    expect(titles()).toEqual(["Status", "Board"]);
  });

  it("leaves Enter alone while an IME is composing", () => {
    renderTab();
    const name = screen.getByRole("textbox", { name: "New link name" });
    const url = screen.getByRole("textbox", { name: "New link URL" });
    fireEvent.change(name, { target: { value: "Status" } });
    fireEvent.change(url, { target: { value: "https://status.example.com" } });
    fireEvent.keyDown(url, { key: "Enter", isComposing: true });

    expect(useGlobalLinksStore.getState().links).toHaveLength(3);
    expect(url).toHaveProperty("value", "https://status.example.com");
  });

  it("flags the name, not the URL, when only the name is missing", () => {
    renderTab();
    const name = screen.getByRole("textbox", { name: "New link name" });
    const url = screen.getByRole("textbox", { name: "New link URL" });
    fireEvent.change(url, { target: { value: "https://linear.app" } });
    fireEvent.keyDown(url, { key: "Enter" });

    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(name)).not.toBe("");
    expect(url.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(name);
    expect(tabHasError.current).toBe(true);
    expect(useGlobalLinksStore.getState().links).toHaveLength(3);
  });

  it("refuses an address that isn't http or https, on the URL field, keeping the draft", () => {
    renderTab();
    const url = screen.getByRole("textbox", { name: "New link URL" }) as HTMLInputElement;
    fireEvent.change(screen.getByRole("textbox", { name: "New link name" }), {
      target: { value: "Files" },
    });
    fireEvent.change(url, { target: { value: "file:///etc/hosts" } });
    fireEvent.click(button("Add"));

    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(url)).not.toBe("");
    expect(url.value).toBe("file:///etc/hosts");
    expect(document.activeElement).toBe(url);
    expect(useGlobalLinksStore.getState().links).toHaveLength(3);
  });
});

describe("LinksSettingsTab editing a link", () => {
  it.each([
    {
      field: "name",
      input: "Link name",
      value: "Handbook",
      sibling: { url: "https://handbook.example.com/" },
      expected: { title: "Handbook", url: "https://handbook.example.com/" },
    },
    {
      field: "URL",
      input: "Link URL",
      value: "https://docs.example.org/",
      sibling: { title: "Docs" },
      expected: { title: "Docs", url: "https://docs.example.org/" },
    },
  ])(
    "writes only the $field edited here, keeping a sibling view's change to the other field",
    ({ input, value, sibling, expected }) => {
      renderTab();
      fireEvent.click(button("Edit Team docs"));
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Link name" }));
      fireEvent.change(screen.getByRole("textbox", { name: input }), { target: { value } });
      act(() => {
        useGlobalLinksStore.getState().updateLink("docs", sibling);
      });
      fireEvent.click(button("Save"));

      expect(stored("docs")).toEqual({ ...DOCS, ...expected });
      expect(document.activeElement).toBe(button(`Edit ${expected.title}`));
    }
  );

  it("saves both fields, trimmed, when both were edited", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    fireEvent.change(screen.getByRole("textbox", { name: "Link name" }), {
      target: { value: " Notes " },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), {
      target: { value: " https://notes.example.com/ " },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link URL" }), { key: "Enter" });

    expect(stored("wiki")).toEqual({ ...WIKI, title: "Notes", url: "https://notes.example.com/" });
  });

  it("keeps Save off until something differs from what the link held", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    const name = screen.getByRole("textbox", { name: "Link name" });
    expect(button("Save").disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Notes" } });
    expect(button("Save").disabled).toBe(false);
    fireEvent.change(name, { target: { value: "Wiki" } });
    expect(button("Save").disabled).toBe(true);
  });

  it("reports an invalid URL on the field and keeps the editor open", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "wiki.example.com" } });
    fireEvent.keyDown(url, { key: "Enter" });

    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(url)).not.toBe("");
    expect(tabHasError.current).toBe(true);
    expect(stored("wiki")?.url).toBe(WIKI.url);
  });

  it("cancels on Escape without letting the key close the dialog around it", () => {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    try {
      renderTab();
      fireEvent.click(button("Edit Wiki"));
      fireEvent.change(screen.getByRole("textbox", { name: "Link name" }), {
        target: { value: "Notes" },
      });
      const notPrevented = fireEvent.keyDown(screen.getByRole("textbox", { name: "Link name" }), {
        key: "Escape",
      });

      expect(notPrevented).toBe(false);
      expect(screen.queryByRole("textbox", { name: "Link name" })).toBeNull();
      expect(outside).not.toHaveBeenCalled();
      expect(titles()).toEqual(["Team docs", "Wiki", "CI"]);
      expect(document.activeElement).toBe(button("Edit Wiki"));
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });

  it.each([
    { signal: "isComposing", init: { isComposing: true } },
    { signal: "keyCode 229", init: { keyCode: 229 } },
  ])("leaves the editor and the dialog open on an IME's Escape ($signal)", ({ init }) => {
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    try {
      renderTab();
      fireEvent.click(button("Edit Wiki"));
      const notPrevented = fireEvent.keyDown(screen.getByRole("textbox", { name: "Link name" }), {
        key: "Escape",
        ...init,
      });
      // The IME still gets the key to dismiss its candidates.
      expect(notPrevented).toBe(true);
      expect(screen.getByRole("textbox", { name: "Link name" })).toBeTruthy();
      expect(outside).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });

  it("drops the draft when another view removes the link, and an Undo there brings back a plain row", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "wiki" } });
    fireEvent.keyDown(url, { key: "Enter" });
    expect(tabHasError.current).toBe(true);

    act(() => useGlobalLinksStore.getState().removeLink("wiki"));
    expect(tabHasError.current).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "New link name" }));

    act(() => useGlobalLinksStore.getState().restoreLink(WIKI, { order: ["docs", "wiki", "ci"] }));
    expect(screen.queryByRole("textbox", { name: "Link name" })).toBeNull();
    expect(button("Edit Wiki")).toBeTruthy();
  });

  it("leaves focus where the person moved it when another view removes the edited link", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    const addUrl = screen.getByRole("textbox", { name: "New link URL" });
    addUrl.focus();
    act(() => useGlobalLinksStore.getState().removeLink("wiki"));
    expect(document.activeElement).toBe(addUrl);
  });
});

describe("LinksSettingsTab removing a link", () => {
  it("removes at once and offers Undo, which puts it back where it was among the links now", () => {
    renderTab();
    fireEvent.click(button("Remove Wiki"));
    expect(titles()).toEqual(["Team docs", "CI"]);
    expect(mockNotify).toHaveBeenCalledTimes(1);

    // The survivors end up where they were, on ranks past the removed link's old one.
    fireEvent.click(button("Move Team docs down"));
    fireEvent.click(button("Move CI down"));
    expect(titles()).toEqual(["Team docs", "CI"]);
    act(() => {
      useGlobalLinksStore.getState().addLink({ title: "New", url: "https://new.test" });
    });

    lastUndo()();
    expect(titles()).toEqual(["Team docs", "Wiki", "CI", "New"]);
    expect({ ...stored("wiki"), order: WIKI.order }).toEqual(WIKI);
  });

  it("lets only the latest removal's Undo restore a link", () => {
    renderTab();
    fireEvent.click(button("Remove Wiki"));
    const firstUndo = lastUndo();
    act(() => useGlobalLinksStore.getState().restoreLink(WIKI, { order: ["docs", "wiki", "ci"] }));
    fireEvent.click(button("Edit Wiki"));
    fireEvent.change(screen.getByRole("textbox", { name: "Link name" }), {
      target: { value: "Notes" },
    });
    fireEvent.click(button("Save"));
    fireEvent.click(button("Remove Notes"));

    firstUndo();
    expect(titles()).toEqual(["Team docs", "CI"]);
    lastUndo()();
    expect(titles()).toEqual(["Team docs", "Notes", "CI"]);
  });

  it("moves focus to the next link's Remove, else the one before, else the add form", () => {
    renderTab();
    const remove = (name: string) => {
      button(name).focus();
      fireEvent.click(button(name));
    };
    remove("Remove Wiki");
    expect(document.activeElement).toBe(button("Remove CI"));
    // Keeping focus in the list is not asking for that button's tooltip.
    expect(isTooltipSuppressedForElement(button("Remove CI"))).toBe(true);

    remove("Remove CI");
    expect(document.activeElement).toBe(button("Remove Team docs"));

    remove("Remove Team docs");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "New link name" }));
  });

  it("passes over a link that can't be removed when moving focus after a removal", () => {
    useGlobalLinksStore.setState({ links: [{ ...DOCS, alwaysEnabled: true }, WIKI] });
    renderTab();
    button("Remove Wiki").focus();
    fireEvent.click(button("Remove Wiki"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "New link name" }));
  });

  it("can neither remove nor switch off a link that can't be switched off", () => {
    useGlobalLinksStore.setState({ links: [{ ...DOCS, alwaysEnabled: true }, WIKI] });
    renderTab();
    expect(button("Remove Team docs").disabled).toBe(true);
    expect(switchFor("Team docs").disabled).toBe(true);
    expect(switchFor("Wiki").disabled).toBe(false);
  });
});

describe("LinksSettingsTab turning a link off and on", () => {
  it("flips only that link, keeping everything else about it", () => {
    renderTab();
    fireEvent.click(switchFor("Wiki"));
    expect(stored("wiki")).toEqual({ ...WIKI, enabled: false });
    expect(switchFor("Wiki").getAttribute("aria-checked")).toBe("false");
    expect(stored("docs")?.enabled).toBe(true);

    fireEvent.click(switchFor("Wiki"));
    expect(stored("wiki")).toEqual(WIKI);
    expect(switchFor("Wiki").getAttribute("aria-checked")).toBe("true");
  });
});

describe("LinksSettingsTab reordering", () => {
  function shownOrder(): string[] {
    return screen
      .getAllByRole("button", { name: /^Edit / })
      .map((b) => b.getAttribute("aria-label")!.slice("Edit ".length));
  }

  it("moves a link one place at a time, disabled links included", () => {
    useGlobalLinksStore.setState({ links: [DOCS, { ...WIKI, enabled: false }, CI] });
    renderTab();
    fireEvent.click(button("Move Wiki down"));
    expect(titles()).toEqual(["Team docs", "CI", "Wiki"]);
    expect(shownOrder()).toEqual(["Team docs", "CI", "Wiki"]);

    fireEvent.click(button("Move CI up"));
    expect(titles()).toEqual(["CI", "Team docs", "Wiki"]);
    expect(shownOrder()).toEqual(["CI", "Team docs", "Wiki"]);
  });

  it("can't move the first link up or the last one down, and can move the rest either way", () => {
    renderTab();
    expect(button("Move Team docs up").disabled).toBe(true);
    expect(button("Move Team docs down").disabled).toBe(false);
    expect(button("Move Wiki up").disabled).toBe(false);
    expect(button("Move Wiki down").disabled).toBe(false);
    expect(button("Move CI up").disabled).toBe(false);
    expect(button("Move CI down").disabled).toBe(true);
  });

  it("puts focus back on the arrow pressed, or the other one once it reaches the end", () => {
    renderTab();
    fireEvent.click(button("Move Team docs down"));
    expect(document.activeElement).toBe(button("Move Team docs down"));

    fireEvent.click(button("Move Team docs down"));
    expect(titles()).toEqual(["Wiki", "CI", "Team docs"]);
    expect(document.activeElement).toBe(button("Move Team docs up"));
  });

  it("offers no arrows for a single link", () => {
    useGlobalLinksStore.setState({ links: [DOCS] });
    renderTab();
    expect(screen.queryByRole("button", { name: "Move Team docs up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move Team docs down" })).toBeNull();
  });
});

describe("LinksSettingsTab following the store", () => {
  it("shows a link added to the store outside the page", () => {
    renderTab();
    act(() => {
      useGlobalLinksStore
        .getState()
        .addLink({ title: "Status", url: "https://status.example.com" });
    });
    expect(button("Edit Status")).toBeTruthy();
  });
});
