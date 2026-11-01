// @vitest-environment jsdom
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix's Select, reduced to what this row hands it: the value it was given
// (on the trigger, so a value no option matches is visible as itself), the
// trigger's own ARIA, and one option per item that picks it on click.
vi.mock("@/components/ui/select", async () => {
  const { createContext, use } = await import("react");
  interface Picker {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }
  const PickerContext = createContext<Picker | null>(null);
  return {
    Select: ({ children, ...picker }: Picker & { children: ReactNode }) => (
      <PickerContext value={picker}>{children}</PickerContext>
    ),
    SelectTrigger: (props: ButtonHTMLAttributes<HTMLButtonElement>) => {
      const picker = use(PickerContext)!;
      return (
        <button
          type="button"
          role="combobox"
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          disabled={picker.disabled}
          data-value={picker.value}
        />
      );
    },
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <div role="listbox">{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const picker = use(PickerContext)!;
      return (
        <div
          role="option"
          aria-selected={picker.value === value}
          onClick={() => picker.onValueChange(value)}
        >
          {children}
        </div>
      );
    },
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

// The real store pulls the list over IPC on `init()`; each test sets the list
// and the actions it watches in `beforeEach` instead.
vi.mock("@/store/projectGroupsStore", async () => {
  const { create } = await import("zustand");
  return { useProjectGroupsStore: create<Record<string, unknown>>(() => ({ groups: [] })) };
});

import { ProjectGroupSettingsRow } from "../ProjectGroupSettingsRow";
import { SettingsDependents, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { makeProjectGroup } from "@/store/__tests__/projectGroupsStoreMock";

const setProjectGroup = vi.fn<(projectId: string, groupId: string | null) => Promise<void>>();
const openDialog = vi.fn();
const init = vi.fn();

const picker = () => screen.queryByRole<HTMLButtonElement>("combobox");
const pickedValue = () => picker()?.getAttribute("data-value");
const pick = (name: string) => fireEvent.click(screen.getByRole("option", { name }));
const newGroupButton = () => screen.getByRole<HTMLButtonElement>("button", { name: /new group/i });
const textOf = (ids: string | null | undefined) =>
  (ids ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

function renderRow(groupId: string | undefined) {
  const ui = (id: string | undefined) => (
    <SettingsGroup>
      <ProjectGroupSettingsRow projectId="p1" groupId={id} />
    </SettingsGroup>
  );
  const result = render(ui(groupId));
  return { ...result, setGroupId: (id: string | undefined) => result.rerender(ui(id)) };
}

beforeEach(() => {
  setProjectGroup.mockReset().mockResolvedValue(undefined);
  openDialog.mockReset();
  init.mockReset();
  useProjectGroupsStore.setState({
    groups: [makeProjectGroup("g1", "Daintree"), makeProjectGroup("g2", "Clients", 1)],
    init,
    setProjectGroup,
    openDialog,
  });
});

describe("ProjectGroupSettingsRow", () => {
  it("loads the group list when it mounts", () => {
    renderRow(undefined);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("names the picker from its row, where settings search lands", () => {
    renderRow("g1");
    const row = document.getElementById("project-group");
    expect(row?.contains(picker())).toBe(true);
    expect(textOf(picker()?.getAttribute("aria-labelledby"))).toBe("Group");
    expect(textOf(picker()?.getAttribute("aria-describedby"))).toMatch(/project switcher/);
  });

  it("shows the project's group and moves it to another", () => {
    renderRow("g1");
    expect(pickedValue()).toBe("g1");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "No group",
      "Daintree",
      "Clients",
    ]);

    pick("Clients");
    expect(setProjectGroup).toHaveBeenCalledWith("p1", "g2");
  });

  it("takes the project out of its group with No group", () => {
    renderRow("g2");
    pick("No group");
    expect(setProjectGroup).toHaveBeenCalledWith("p1", null);
  });

  it("reads a group that no longer exists as no group", () => {
    renderRow("gone");
    expect(pickedValue()).toBe("no-group");
  });

  it("follows the project when the host files it elsewhere", () => {
    const { setGroupId } = renderRow("g1");
    pick("Clients");
    // The pick is only a request: until the project comes back moved, the row
    // still says where it is.
    expect(pickedValue()).toBe("g1");

    setGroupId("g2");
    expect(pickedValue()).toBe("g2");
  });

  it("follows groups renamed or deleted elsewhere", () => {
    renderRow("g2");
    act(() => {
      useProjectGroupsStore.setState({
        groups: [makeProjectGroup("g1", "Daintree"), makeProjectGroup("g2", "Client work", 1)],
      });
    });
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("Client work");

    act(() => {
      useProjectGroupsStore.setState({ groups: [makeProjectGroup("g1", "Daintree")] });
    });
    expect(pickedValue()).toBe("no-group");
  });

  it("sends nothing when the project's own group is picked again", () => {
    renderRow("g1");
    pick("Daintree");
    expect(setProjectGroup).not.toHaveBeenCalled();
  });

  it("sends nothing when No group is picked for a project in no group", () => {
    renderRow("gone");
    pick("No group");
    expect(setProjectGroup).not.toHaveBeenCalled();
  });

  it("offers a new group from the project before any group exists", () => {
    useProjectGroupsStore.setState({ groups: [] });
    renderRow(undefined);

    expect(picker()).toBeNull();
    fireEvent.click(newGroupButton());
    expect(openDialog).toHaveBeenCalledWith({ kind: "create", projectId: "p1" });
  });

  it("offers a new group beside the picker once groups exist", () => {
    renderRow("g1");
    fireEvent.click(newGroupButton());
    expect(openDialog).toHaveBeenCalledWith({ kind: "create", projectId: "p1" });
  });

  it("disables both controls while the row is disabled", () => {
    render(
      <SettingsGroup>
        <SettingsDependents disabled reason="Off for this test">
          <ProjectGroupSettingsRow projectId="p1" groupId="g1" />
        </SettingsDependents>
      </SettingsGroup>
    );
    expect(picker()?.disabled).toBe(true);
    expect(newGroupButton().disabled).toBe(true);
    fireEvent.click(newGroupButton());
    expect(openDialog).not.toHaveBeenCalled();
  });
});
