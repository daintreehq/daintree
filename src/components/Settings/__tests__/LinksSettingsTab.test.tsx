// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../SettingsValidationRegistry", () => ({ useSettingsTabValidation: () => {} }));
const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));

import { TooltipProvider } from "@/components/ui/tooltip";
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

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** The text an element's aria-describedby actually resolves to. */
function describedText(el: Element): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

beforeEach(() => {
  mockNotify.mockReset();
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
    expect(screen.getByText("Linear")).toBeTruthy();
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
    expect(useGlobalLinksStore.getState().links).toHaveLength(3);
  });

  it("refuses an address that isn't http or https, on the URL field", () => {
    renderTab();
    const url = screen.getByRole("textbox", { name: "New link URL" });
    fireEvent.change(screen.getByRole("textbox", { name: "New link name" }), {
      target: { value: "Files" },
    });
    fireEvent.change(url, { target: { value: "file:///etc/hosts" } });
    fireEvent.click(button("Add"));

    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(url);
    expect(useGlobalLinksStore.getState().links).toHaveLength(3);
  });
});

describe("LinksSettingsTab editing a link", () => {
  it("writes only the fields edited here, keeping a sibling view's change to the others", () => {
    renderTab();
    fireEvent.click(button("Edit Team docs"));
    const name = screen.getByRole("textbox", { name: "Link name" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Handbook" } });
    // Another view re-points the link while this one is renaming it.
    act(() => {
      useGlobalLinksStore.getState().updateLink("docs", { url: "https://handbook.example.com/" });
    });
    fireEvent.click(button("Save"));

    const saved = useGlobalLinksStore.getState().links.find((l) => l.id === "docs");
    expect(saved?.title).toBe("Handbook");
    expect(saved?.url).toBe("https://handbook.example.com/");
    expect(document.activeElement).toBe(button("Edit Handbook"));
  });

  it("keeps Save off until something changes", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    expect(button("Save").disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Link URL" }), {
      target: { value: "https://wiki.example.org/" },
    });
    expect(button("Save").disabled).toBe(false);
  });

  it("reports an invalid URL on the field and keeps the editor open", () => {
    renderTab();
    fireEvent.click(button("Edit Wiki"));
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "wiki.example.com" } });
    fireEvent.keyDown(url, { key: "Enter" });

    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(url)).not.toBe("");
    expect(useGlobalLinksStore.getState().links[1]?.url).toBe(WIKI.url);
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
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Link name" }), { key: "Escape" });

      expect(screen.queryByRole("textbox", { name: "Link name" })).toBeNull();
      expect(outside).not.toHaveBeenCalled();
      expect(titles()).toEqual(["Team docs", "Wiki", "CI"]);
      expect(document.activeElement).toBe(button("Edit Wiki"));
    } finally {
      document.removeEventListener("keydown", outside);
    }
  });
});

describe("LinksSettingsTab removing a link", () => {
  it("removes at once and offers Undo, which puts it back where it was", () => {
    renderTab();
    fireEvent.click(button("Remove Wiki"));

    expect(titles()).toEqual(["Team docs", "CI"]);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0]![0] as {
      action: { label: string; onClick: () => void };
    };
    expect(payload.action.label).toBe("Undo");
    act(() => payload.action.onClick());
    expect(useGlobalLinksStore.getState().links.map((l) => l.id)).toEqual(["docs", "wiki", "ci"]);
  });

  it("moves focus to the next link's Remove, then the one before, then the add form", () => {
    useGlobalLinksStore.setState({ links: [DOCS, WIKI] });
    renderTab();
    fireEvent.click(button("Remove Team docs"));
    expect(document.activeElement).toBe(button("Remove Wiki"));

    fireEvent.click(button("Remove Wiki"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "New link name" }));
  });

  it("leaves a link that can't be switched off in place", () => {
    useGlobalLinksStore.setState({ links: [{ ...DOCS, alwaysEnabled: true }, WIKI] });
    renderTab();
    expect(button("Remove Team docs").disabled).toBe(true);
    const [docsSwitch, wikiSwitch] = screen.getAllByRole("switch") as HTMLButtonElement[];
    expect(docsSwitch!.disabled).toBe(true);
    expect(wikiSwitch!.disabled).toBe(false);
  });
});

describe("LinksSettingsTab turning a link off", () => {
  it("keeps the link, only off", () => {
    renderTab();
    const [, wikiSwitch] = screen.getAllByRole("switch");
    fireEvent.click(wikiSwitch!);
    expect(useGlobalLinksStore.getState().links.map((l) => [l.id, l.enabled])).toEqual([
      ["docs", true],
      ["wiki", false],
      ["ci", true],
    ]);
  });
});

describe("LinksSettingsTab reordering", () => {
  it("moves a link one place at a time, disabled links included", () => {
    useGlobalLinksStore.setState({ links: [DOCS, { ...WIKI, enabled: false }, CI] });
    renderTab();
    fireEvent.click(button("Move Wiki down"));
    expect(titles()).toEqual(["Team docs", "CI", "Wiki"]);

    fireEvent.click(button("Move CI up"));
    expect(titles()).toEqual(["CI", "Team docs", "Wiki"]);
  });

  it("can't move the first link up or the last one down", () => {
    renderTab();
    expect(button("Move Team docs up").disabled).toBe(true);
    expect(button("Move Team docs down").disabled).toBe(false);
    expect(button("Move CI down").disabled).toBe(true);
  });

  it("keeps focus on the arrow pressed, or the other one once it reaches the end", () => {
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

describe("LinksSettingsTab and other views", () => {
  it("shows a link another view added", () => {
    renderTab();
    act(() => {
      useGlobalLinksStore
        .getState()
        .addLink({ title: "Status", url: "https://status.example.com" });
    });
    expect(screen.getByRole("button", { name: "Edit Status" })).toBeTruthy();
  });
});
