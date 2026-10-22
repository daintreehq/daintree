// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  PluginFilter,
  PluginFilterCondition,
  PluginFilterField,
  PluginSavedView,
  PluginSavedViewState,
} from "@shared/types/plugin-sdk-react";
import { primeRadix } from "@/components/ui/radix-loader";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  PluginKitViewHostContext,
  type PluginKitViewHost,
} from "@/components/PluginKit/kitViewHost";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));
// The builder's pickers are driven as values, not as Radix popups.
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));

import * as kit from "@daintreehq/plugin-ui";
import "@/components/PluginKit/PluginKit";
import { VIEW_STATE_KEY_PREFIX } from "../viewState";

beforeAll(async () => {
  await primeRadix();
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fields: PluginFilterField[] = [
  {
    id: "status",
    label: "Status",
    type: "select",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  },
  { id: "owner", label: "Owner", type: "select", options: [{ value: "me", label: "Me" }] },
  { id: "title", label: "Title", type: "text" },
  { id: "archived", label: "Archived", type: "boolean" },
];

const none: PluginFilter = { match: "all", conditions: [] };

/** A plugin holding the filter in its own state, as the docs show. */
function Builder({
  initial,
  onChange,
}: {
  initial: PluginFilter;
  onChange?: (next: PluginFilter) => void;
}) {
  const [value, setValue] = useState(initial);
  return createElement(kit.FilterBuilder, {
    fields,
    value,
    "aria-label": "Issue filters",
    onChange: (next: PluginFilter) => {
      setValue(next);
      onChange?.(next);
    },
  });
}

type FilterSpy = (next: PluginFilter) => void;

function lastFilter(spy: { mock: { lastCall?: Parameters<FilterSpy> } }): PluginFilter {
  const call = spy.mock.lastCall;
  if (!call) throw new Error("onChange was not called");
  return call[0];
}

const rows = () => screen.getAllByRole("group", { name: /^Condition \d+$/ });
const pick = (row: HTMLElement, name: string, value: string) =>
  fireEvent.change(within(row).getByRole("combobox", { name }), { target: { value } });

describe("FilterBuilder", () => {
  it("builds Status is Open and Owner is me, a filter readFilter accepts", () => {
    const onChange = vi.fn<FilterSpy>();
    render(createElement(Builder, { initial: none, onChange }));
    const add = screen.getByRole("button", { name: "Add condition" });
    fireEvent.click(add);
    expect(document.activeElement).toBe(
      within(rows()[0]!).getByRole("combobox", { name: "Field" })
    );
    pick(rows()[0]!, "Value", "open");
    fireEvent.click(add);
    pick(rows()[1]!, "Field", "owner");
    pick(rows()[1]!, "Value", "me");
    const last = lastFilter(onChange);
    expect(last).toEqual({
      match: "all",
      conditions: [
        { field: "status", op: "eq", value: "open" },
        { field: "owner", op: "eq", value: "me" },
      ],
    });
    expect(kit.readFilter(last, fields)).toEqual(last);
    expect(kit.matchesFilter(last, { status: "open", owner: "me" }, fields)).toBe(true);
  });

  it("offers All or Any once there are two conditions", () => {
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(Builder, {
        initial: { match: "all", conditions: [{ field: "title", op: "contains", value: "bug" }] },
        onChange,
      })
    );
    expect(screen.queryByRole("combobox", { name: "Match" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Match" }), { target: { value: "any" } });
    expect(lastFilter(onChange).match).toBe("any");
  });

  it("resets the comparison and value on a new field, and keeps a value across comparisons", () => {
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(Builder, {
        initial: { match: "all", conditions: [{ field: "title", op: "eq", value: "Login" }] },
        onChange,
      })
    );
    const row = rows()[0]!;
    pick(row, "Comparison", "contains");
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "title", op: "contains", value: "Login" }],
    });
    pick(row, "Comparison", "empty");
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "title", op: "empty" }],
    });
    expect(within(row).queryByRole("textbox", { name: "Value" })).toBeNull();
    pick(row, "Field", "archived");
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "archived", op: "eq" }],
    });
    pick(rows()[0]!, "Value", "false");
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "archived", op: "eq", value: false }],
    });
  });

  it("leaves a cleared text value out rather than storing an empty string", () => {
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(Builder, {
        initial: { match: "all", conditions: [{ field: "title", op: "contains", value: "a" }] },
        onChange,
      })
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "title", op: "contains" }],
    });
  });

  it("keeps conditions the schema no longer allows, says why, and saves them back untouched", () => {
    const stale: PluginFilterCondition[] = [
      { field: "priority", op: "eq", value: "high" },
      { field: "title", op: "gt", value: "a" },
      { field: "status", op: "eq", value: "triage" },
    ];
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(Builder, {
        initial: { match: "any", conditions: [...stale, { field: "title", op: "eq", value: "x" }] },
        onChange,
      })
    );
    const [unknownField, badOp, goneOption, fine] = rows();
    expect(within(unknownField!).getByText("This field isn't available")).toBeTruthy();
    expect(within(badOp!).getByText("This comparison isn't available for Title")).toBeTruthy();
    expect(within(goneOption!).getByText("This value isn't available for Status")).toBeTruthy();
    // The control says what it holds, and points at the reason.
    const field = within(unknownField!).getByRole("combobox", { name: "Field" });
    expect(field.textContent).toContain("priority");
    expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "This field isn't available"
    );
    pick(fine!, "Comparison", "neq");
    const sent = lastFilter(onChange);
    expect(sent.match).toBe("any");
    expect(sent.conditions.slice(0, 3)).toEqual(stale);
    expect(sent.conditions[0]).toBe(stale[0]);
    expect(kit.readFilter(sent, fields)).toBeNull();
  });

  it("repairs a condition with an unknown field by choosing a field", () => {
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(Builder, {
        initial: {
          match: "all",
          conditions: [{ field: "priority", op: "eq", value: "high" }],
        },
        onChange,
      })
    );
    pick(rows()[0]!, "Field", "status");
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      conditions: [{ field: "status", op: "eq" }],
    });
    expect(screen.queryByText("This field isn't available")).toBeNull();
  });

  it("moves focus to a neighbour's Remove, then to Add, as conditions go", () => {
    render(
      createElement(Builder, {
        initial: {
          match: "all",
          conditions: [
            { field: "title", op: "eq", value: "a" },
            { field: "title", op: "eq", value: "b" },
          ],
        },
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove condition 1" }));
    expect(rows()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove condition 1" }));
    expect((screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).value).toBe("b");
    fireEvent.click(screen.getByRole("button", { name: "Remove condition 1" }));
    expect(screen.queryAllByRole("group", { name: /^Condition/ })).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add condition" }));
  });

  it("keeps each row's key when the plugin hands back a copy", () => {
    function Copying() {
      const [value, setValue] = useState<PluginFilter>({
        match: "all",
        conditions: [
          { field: "title", op: "eq", value: "a" },
          { field: "title", op: "eq", value: "a" },
        ],
      });
      return createElement(kit.FilterBuilder, {
        fields,
        value,
        "aria-label": "Filters",
        onChange: (next: PluginFilter) => setValue(JSON.parse(JSON.stringify(next))),
      });
    }
    render(createElement(Copying));
    const second = rows()[1]!;
    fireEvent.change(within(rows()[0]!).getByRole("textbox", { name: "Value" }), {
      target: { value: "z" },
    });
    expect(rows()[1]).toBe(second);
    expect(
      rows().map((row) => (within(row).getByRole("textbox") as HTMLInputElement).value)
    ).toEqual(["z", "a"]);
  });

  it("disables every control, and changes nothing, when disabled", () => {
    const onChange = vi.fn<FilterSpy>();
    render(
      createElement(kit.FilterBuilder, {
        fields,
        value: { match: "all", conditions: [{ field: "title", op: "eq", value: "a" }] },
        onChange,
        disabled: true,
        "aria-label": "Filters",
      })
    );
    const group = screen.getByRole("group", { name: "Filters" });
    for (const control of group.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      "button, input, select"
    )) {
      expect(control.disabled).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("contains a throwing onChange and offers no Add without a usable field", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      createElement(kit.FilterBuilder, {
        fields: [{ id: "x", label: "X", type: "text", operators: [] }],
        value: none,
        onChange: () => {
          throw new Error("boom");
        },
        "aria-label": "Filters",
      })
    );
    expect(
      (screen.getByRole("button", { name: "Add condition" }) as HTMLButtonElement).disabled
    ).toBe(true);
    cleanup();
    render(
      createElement(kit.FilterBuilder, {
        fields,
        value: none,
        onChange: () => {
          throw new Error("boom");
        },
        "aria-label": "Filters",
      })
    );
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Add condition" }))
    ).not.toThrow();
    error.mockRestore();
  });
});

// ---------------------------------------------------------------------------

const open: PluginFilter = {
  match: "all",
  conditions: [{ field: "status", op: "eq", value: "open" }],
};
const mine: PluginFilter = {
  match: "all",
  conditions: [
    { field: "status", op: "eq", value: "open" },
    { field: "owner", op: "eq", value: "me" },
  ],
};
const openView: PluginSavedView = {
  id: "open",
  name: "Open",
  filter: open,
  sort: { columnId: "updated", direction: "desc" },
  hiddenColumns: ["owner", "points"],
};
const mineView: PluginSavedView = {
  id: "mine",
  name: "Mine",
  filter: mine,
  sort: null,
  hiddenColumns: [],
};

function hostWith(initialArgs?: Record<string, unknown>) {
  const persistState = vi.fn<(patch: Record<string, unknown>) => boolean>(() => true);
  const host: PluginKitViewHost = { initialArgs, persistState, root: { current: null } };
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      PluginKitViewHostContext.Provider,
      { value: host },
      createElement(TooltipProvider, null, children)
    );
  return { persistState, wrapper };
}

/** A plugin view: its choices in state, a SavedViews remembering the views. */
function Screen({
  initial,
  onApplied,
  defaultViews = [openView, mineView],
  defaultActiveViewId,
}: {
  initial: PluginSavedViewState;
  onApplied?: (state: PluginSavedViewState) => void;
  defaultViews?: PluginSavedView[];
  defaultActiveViewId?: string;
}) {
  const [state, setState] = useState(initial);
  return createElement(
    "div",
    null,
    createElement(kit.SavedViews, {
      current: state,
      viewStateKey: "issues",
      defaultViews,
      defaultActiveViewId,
      onApply: (next: PluginSavedViewState) => {
        setState(next);
        onApplied?.(next);
      },
    }),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setState((current) => ({ ...current, hiddenColumns: ["owner"] })),
      },
      "Hide owner only"
    ),
    createElement("output", { "data-testid": "state" }, JSON.stringify(state))
  );
}

const trigger = () => screen.getByRole("button", { name: /^Saved views: / });

async function openMenu() {
  const button = trigger();
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "ArrowDown" });
  });
  return screen.findByRole("menu");
}

async function choose(name: string) {
  const menu = await openMenu();
  const item = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (element) => element.textContent?.trim() === name
  );
  if (!item) throw new Error(`no menu item "${name}"`);
  await act(async () => {
    fireEvent.click(item);
  });
}

const stateShown = (): PluginSavedViewState =>
  JSON.parse(screen.getByTestId("state").textContent ?? "null");

describe("SavedViews", () => {
  it("switches views, applying all three choices", async () => {
    const onApplied = vi.fn<(state: PluginSavedViewState) => void>();
    const { wrapper } = hostWith();
    render(createElement(Screen, { initial: { ...mineView }, onApplied }), { wrapper });
    expect(trigger().textContent).toContain("Views");
    await choose("Open");
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(stateShown()).toEqual({
      filter: open,
      sort: openView.sort,
      hiddenColumns: openView.hiddenColumns,
    });
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open");
  });

  it("marks a change, ignores the order of hidden columns, and reverts", async () => {
    const { wrapper } = hostWith();
    render(
      createElement(Screen, {
        initial: { ...openView, hiddenColumns: ["points", "owner"] },
        defaultActiveViewId: "open",
      }),
      { wrapper }
    );
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open");
    fireEvent.click(screen.getByRole("button", { name: "Hide owner only" }));
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open, modified");
    expect(trigger().textContent).toContain("Modified");
    await choose("Revert changes");
    expect(stateShown().hiddenColumns).toEqual(["owner", "points"]);
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open");
  });

  it("saves changes into the chosen view and remembers them for the view", async () => {
    const { persistState, wrapper } = hostWith();
    render(createElement(Screen, { initial: { ...openView }, defaultActiveViewId: "open" }), {
      wrapper,
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide owner only" }));
    await choose("Save changes");
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open");
    expect(persistState.mock.lastCall?.[0]).toMatchObject({
      [`${VIEW_STATE_KEY_PREFIX}savedViews:issues`]: {
        views: expect.arrayContaining([
          expect.objectContaining({ id: "open", hiddenColumns: ["owner"] }),
        ]),
      },
    });
  });

  it("saves the current choices as a new view, refusing a blank or taken name", async () => {
    const { wrapper } = hostWith();
    render(createElement(Screen, { initial: { ...mineView, hiddenColumns: ["title"] } }), {
      wrapper,
    });
    await choose("Save view…");
    const dialog = await screen.findByRole("dialog", { name: "Save view" });
    const name = within(dialog).getByRole("textbox", { name: "View name" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    expect(within(dialog).getByText("Enter a view name")).toBeTruthy();
    fireEvent.change(name, { target: { value: " mine " } });
    fireEvent.submit(name.closest("form")!);
    expect(within(dialog).getByText("A view with this name already exists")).toBeTruthy();
    fireEvent.change(name, { target: { value: "Mine, no title" } });
    await act(async () => {
      fireEvent.submit(name.closest("form")!);
    });
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Mine, no title");
    const menu = await openMenu();
    const radios = within(menu).getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Open", "Mine", "Mine, no title"]);
    expect(radios[2]!.getAttribute("aria-checked")).toBe("true");
  });

  it("renames the chosen view", async () => {
    const { wrapper } = hostWith();
    render(createElement(Screen, { initial: { ...mineView }, defaultActiveViewId: "mine" }), {
      wrapper,
    });
    await choose("Rename view…");
    const dialog = await screen.findByRole("dialog", { name: "Rename view" });
    const name = within(dialog).getByRole("textbox", { name: "View name" }) as HTMLInputElement;
    expect(name.value).toBe("Mine");
    fireEvent.change(name, { target: { value: "Assigned to me" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rename view" }));
    });
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Assigned to me");
  });

  it("removes the chosen view after a confirm, leaving the choices on screen", async () => {
    const onApplied = vi.fn<(state: PluginSavedViewState) => void>();
    const { wrapper } = hostWith();
    render(
      createElement(Screen, { initial: { ...mineView }, defaultActiveViewId: "mine", onApplied }),
      { wrapper }
    );
    await choose("Remove view…");
    const confirm = await screen.findByRole("alertdialog", { name: "Remove 'Mine'?" });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: "Remove view" }));
    });
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Views");
    expect(onApplied).not.toHaveBeenCalled();
    expect(stateShown().filter).toEqual(mine);
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((radio) => radio.textContent)
    ).toEqual(["Open"]);
  });

  it("restores remembered views, leaving out entries that cannot be read whole", () => {
    const { wrapper } = hostWith({
      [`${VIEW_STATE_KEY_PREFIX}savedViews:issues`]: {
        views: [
          openView,
          { ...mineView, id: "open" },
          { id: "broken", name: "Broken", filter: "status=open", sort: null, hiddenColumns: [] },
          { id: "sorted", name: "Sorted", filter: open, sort: { columnId: "x", direction: "up" } },
          {
            id: "legacy",
            name: "Legacy",
            filter: { match: "all", conditions: [{ field: "priority", op: "eq", value: "high" }] },
          },
        ],
        active: "legacy",
      },
    });
    render(createElement(Screen, { initial: { ...openView }, defaultViews: [] }), { wrapper });
    // A field the schema dropped is the builder's to flag; the view stays.
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Legacy, modified");
  });

  it("starts from nothing when what was remembered is not views at all", () => {
    const { wrapper } = hostWith({ [`${VIEW_STATE_KEY_PREFIX}savedViews:issues`]: "garbage" });
    render(createElement(Screen, { initial: { ...openView }, defaultActiveViewId: "open" }), {
      wrapper,
    });
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Open");
  });

  it("follows controlled views and reports every change", async () => {
    const onViewsChange = vi.fn();
    const onActiveViewChange = vi.fn();
    const onApply = vi.fn<(state: PluginSavedViewState) => void>();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(kit.SavedViews, {
          current: { ...mineView },
          views: [openView, mineView],
          activeViewId: "mine",
          onViewsChange,
          onActiveViewChange,
          onApply,
          placeholder: "All issues",
        })
      )
    );
    await choose("Open");
    expect(onApply).toHaveBeenCalledWith({
      filter: open,
      sort: openView.sort,
      hiddenColumns: openView.hiddenColumns,
    });
    expect(onActiveViewChange).toHaveBeenCalledWith("open");
    // Still controlled: the plugin did not move it.
    expect(trigger().getAttribute("aria-label")).toBe("Saved views: Mine");
    expect(onApply.mock.lastCall?.[0]?.filter).not.toBe(openView.filter);
    expect(onViewsChange).not.toHaveBeenCalled();
  });
});
