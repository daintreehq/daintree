// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalLink } from "@shared/types/portal";
import type { GlobalLink } from "@/store/globalLinksStore";
import { DEFAULT_SYSTEM_LINKS } from "@shared/types";

const dispatch = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatch(...args) },
}));
vi.mock("../SettingsValidationRegistry", () => ({ useSettingsTabValidation: () => {} }));
// A native select stands in for the Radix one, which jsdom can't open.
vi.mock("../SettingsSelect", () => ({
  SettingsSelect: ({
    label,
    value,
    options,
    onValueChange,
  }: {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onValueChange: (value: string) => void;
  }) => (
    <select aria-label={label} value={value} onChange={(e) => onValueChange(e.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const portal = vi.hoisted(() => ({
  links: [] as PortalLink[],
  defaultNewTabUrl: null as string | null,
}));
vi.mock("@/store/portalStore", () => ({
  usePortalStore: Object.assign((selector: (s: typeof portal) => unknown) => selector(portal), {
    getState: () => portal,
  }),
}));
const globalLinks = vi.hoisted(() => ({ links: [] as GlobalLink[] }));
vi.mock("@/store/globalLinksStore", () => ({
  useGlobalLinksStore: Object.assign(
    (selector: (s: typeof globalLinks) => unknown) => selector(globalLinks),
    { getState: () => globalLinks }
  ),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { PortalSettingsTab } from "../PortalSettingsTab";

const DOCS: GlobalLink = {
  id: "docs",
  title: "Team docs",
  url: "https://docs.example.com",
  icon: "globe",
  enabled: true,
  order: 0,
};

function renderTab() {
  return render(
    <TooltipProvider>
      <PortalSettingsTab />
    </TooltipProvider>
  );
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
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true, result: undefined });
  portal.links = [];
  globalLinks.links = [DOCS];
  portal.defaultNewTabUrl = null;
});

const SHIPPED = DEFAULT_SYSTEM_LINKS[0]!;

describe("PortalSettingsTab built-in link editing", () => {
  beforeEach(() => {
    portal.links = [{ ...SHIPPED }];
  });

  it("reports an invalid edit on the URL being edited and writes nothing", async () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const url = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "docs.example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(url)).not.toBe("");
    expect(dispatch).not.toHaveBeenCalledWith(
      "portal.links.update",
      expect.anything(),
      expect.anything()
    );
  });

  it("keeps the editor open with its draft when the save fails", async () => {
    dispatch.mockResolvedValue({ ok: false, error: { message: "store unavailable" } });
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Link name" }), {
      target: { value: "Handbook" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    const name = screen.getByRole("textbox", { name: "Link name" }) as HTMLInputElement;
    expect(name.value).toBe("Handbook");
  });

  it("hands focus back to the link's Edit button when the editor closes", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Link name" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const edit = screen.getByRole("button", { name: "Edit" });
    expect(document.activeElement).toBe(edit);
  });
});

describe("PortalSettingsTab custom new-tab URL", () => {
  it("keeps Save off while the URL matches the one already saved", () => {
    portal.defaultNewTabUrl = "https://intranet.example.com";
    renderTab();
    fireEvent.change(screen.getByRole("combobox", { name: "New tabs open" }), {
      target: { value: "custom" },
    });
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Custom URL" }), {
      target: { value: "https://intranet.example.com/home" },
    });
    expect(save().disabled).toBe(false);
  });
});

describe("PortalSettingsTab while a save is in flight", () => {
  it("won't open a second editor, or close the first, until the save answers", async () => {
    const [first, second] = DEFAULT_SYSTEM_LINKS;
    portal.links = [
      { ...first!, order: 0 },
      { ...second!, order: 1 },
    ];
    let answer: (value: unknown) => void = () => {};
    renderTab();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Link name" }), {
      target: { value: "Handbook" },
    });
    dispatch.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    const otherEdit = screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
    expect(otherEdit.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Link name" }), { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "Link name" })).toBeTruthy();

    await act(async () => answer({ ok: true, result: undefined }));
  });
});

describe("PortalSettingsTab new-tab choices", () => {
  it("offers the enabled built-in links, then the enabled global links in their own order", () => {
    const [first, second] = DEFAULT_SYSTEM_LINKS;
    portal.links = [
      { ...first!, order: 0 },
      { ...second!, order: 1, enabled: false },
    ];
    globalLinks.links = [
      { ...DOCS, id: "wiki", title: "Wiki", url: "https://wiki.example.com", order: 0 },
      {
        ...DOCS,
        id: "off",
        title: "Off",
        url: "https://off.example.com",
        order: 1,
        enabled: false,
      },
      { ...DOCS, order: 2 },
    ];
    renderTab();

    const select = screen.getByRole("combobox", { name: "New tabs open" }) as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels.slice(1, -1)).toEqual([first!.title, "Wiki", "Team docs"]);
  });
});

describe("PortalSettingsTab new-tab default from a global link", () => {
  it("shows a global link chosen as the default as that link, not as a custom URL", () => {
    portal.defaultNewTabUrl = DOCS.url;
    renderTab();
    const select = screen.getByRole("combobox", { name: "New tabs open" }) as HTMLSelectElement;
    expect(select.value).toBe(DOCS.url);
    expect(screen.queryByRole("textbox", { name: "Custom URL" })).toBeNull();
  });

  it("treats the default as a custom URL once that global link is switched off", () => {
    portal.defaultNewTabUrl = DOCS.url;
    globalLinks.links = [{ ...DOCS, enabled: false }];
    renderTab();
    const select = screen.getByRole("combobox", { name: "New tabs open" }) as HTMLSelectElement;
    expect(select.value).toBe("custom");
  });
});

describe("PortalSettingsTab built-in links", () => {
  it("marks a changed built-in link and restores what shipped", () => {
    const shipped = DEFAULT_SYSTEM_LINKS[0]!;
    portal.links = [{ ...shipped, url: "https://example.com/elsewhere" }];
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: `Reset ${shipped.title} to its default` }));

    expect(dispatch).toHaveBeenCalledWith(
      "portal.links.update",
      {
        id: shipped.id,
        updates: { title: shipped.title, url: shipped.url, enabled: shipped.enabled },
      },
      { source: "user" }
    );
  });

  it("offers no reset for a built-in link that matches what shipped", () => {
    const shipped = DEFAULT_SYSTEM_LINKS[0]!;
    portal.links = [{ ...shipped }];
    renderTab();
    expect(
      screen.queryByRole("button", { name: `Reset ${shipped.title} to its default` })
    ).toBeNull();
  });
});

describe("PortalSettingsTab custom new-tab URL failure", () => {
  it("reports a failed write as a form problem and announces it", async () => {
    renderTab();
    fireEvent.change(screen.getByRole("combobox", { name: "New tabs open" }), {
      target: { value: "custom" },
    });
    const url = screen.getByRole("textbox", { name: "Custom URL" });
    fireEvent.change(url, { target: { value: "https://intranet.example.com" } });
    dispatch.mockResolvedValue({ ok: false, error: { message: "store unavailable" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(url.getAttribute("aria-invalid")).toBeNull();
    expect(describedText(url)).not.toBe("");
    const first = screen.getByRole("alert");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    // Same words, new node: a repeated failure is announced again.
    const second = screen.getByRole("alert");
    expect(second.textContent).toBe(first.textContent);
    expect(second).not.toBe(first);
  });

  it("reopens a saved custom URL for editing from its own Edit button", () => {
    portal.defaultNewTabUrl = "https://intranet.example.com";
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Edit", description: "Custom URL" }));

    const url = screen.getByRole("textbox", { name: "Custom URL" }) as HTMLInputElement;
    expect(url.value).toBe("https://intranet.example.com");
  });
});

describe("PortalSettingsTab and the person's own links", () => {
  it("lists none of them and takes no new ones", () => {
    globalLinks.links = [DOCS];
    renderTab();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "New link URL" })).toBeNull();
  });

  it("sends the person to the Links page to manage them", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Open Links settings" }));
    expect(dispatch).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "links", sectionId: "global-links" },
      { source: "user" }
    );
  });
});
