// @vitest-environment jsdom
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A native select stands in for Radix's, so a choice can be driven with a
// change event; options keep their visible text.
vi.mock("@/components/ui/select", async () => {
  const { isValidElement } = await import("react");
  const textOf = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
    return "";
  };
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      disabled?: boolean;
      children: ReactNode;
    }) => (
      <select
        aria-label="Group"
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
      <option value={value}>{textOf(children)}</option>
    ),
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
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { makeProjectGroup } from "@/store/__tests__/projectGroupsStoreMock";

const setProjectGroup = vi.fn<(projectId: string, groupId: string | null) => Promise<void>>();
const openDialog = vi.fn();
const init = vi.fn();

const groupSelect = () => screen.queryByRole<HTMLSelectElement>("combobox");
const newGroupButton = () => screen.getByRole("button", { name: /new group/i });

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
  } as never);
});

describe("ProjectGroupSettingsRow", () => {
  it("loads the group list when it mounts", () => {
    renderRow(undefined);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("shows the project's group and moves it to another", () => {
    renderRow("g1");
    expect(groupSelect()?.value).toBe("g1");
    expect(Array.from(groupSelect()!.options, (option) => option.text)).toEqual([
      "No group",
      "Daintree",
      "Clients",
    ]);

    fireEvent.change(groupSelect()!, { target: { value: "g2" } });
    expect(setProjectGroup).toHaveBeenCalledWith("p1", "g2");
  });

  it("takes the project out of its group with No group", () => {
    renderRow("g2");
    fireEvent.change(groupSelect()!, { target: { value: "no-group" } });
    expect(setProjectGroup).toHaveBeenCalledWith("p1", null);
  });

  it("reads a group that no longer exists as no group", () => {
    renderRow("gone");
    expect(groupSelect()?.value).toBe("no-group");
  });

  it("holds the pick while the move is in flight, then follows the saved group", async () => {
    let settle!: () => void;
    setProjectGroup.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));
    const { setGroupId } = renderRow("g1");

    fireEvent.change(groupSelect()!, { target: { value: "g2" } });
    expect(groupSelect()?.value).toBe("g2");

    // A move that failed leaves the project where it was, and the row says so.
    await act(async () => settle());
    expect(groupSelect()?.value).toBe("g1");

    setGroupId("g2");
    expect(groupSelect()?.value).toBe("g2");
  });

  it("keeps the latest of two quick picks shown when the first settles", async () => {
    const settles: Array<() => void> = [];
    setProjectGroup.mockImplementation(
      () => new Promise<void>((resolve) => settles.push(() => resolve()))
    );
    renderRow(undefined);

    fireEvent.change(groupSelect()!, { target: { value: "g1" } });
    fireEvent.change(groupSelect()!, { target: { value: "g2" } });
    await act(async () => settles[0]!());

    expect(groupSelect()?.value).toBe("g2");
  });

  it("sends nothing when the project's own group is picked again", () => {
    renderRow("g1");
    fireEvent.change(groupSelect()!, { target: { value: "g1" } });
    expect(setProjectGroup).not.toHaveBeenCalled();
  });

  it("offers a new group from the project before any group exists", () => {
    useProjectGroupsStore.setState({ groups: [] });
    renderRow(undefined);

    expect(groupSelect()).toBeNull();
    fireEvent.click(newGroupButton());
    expect(openDialog).toHaveBeenCalledWith({ kind: "create", projectId: "p1" });
  });

  it("offers a new group beside the picker once groups exist", () => {
    renderRow("g1");
    fireEvent.click(newGroupButton());
    expect(openDialog).toHaveBeenCalledWith({ kind: "create", projectId: "p1" });
  });
});
