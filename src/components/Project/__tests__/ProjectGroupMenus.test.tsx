// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: unknown) => fn,
}));

vi.mock("@/store/portalStore", () => ({
  usePortalStore: () => ({ isOpen: false, width: 0 }),
}));

vi.mock("@/hooks/useOverlayState", () => ({
  useOverlayState: () => {},
}));

vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    list: vi.fn(() => Promise.resolve([])),
    onUpdate: vi.fn(() => () => {}),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    setSortMode: vi.fn(),
    setMembership: vi.fn(),
    setArchived: vi.fn(),
  },
}));
vi.mock("@/clients/projectGroupsClient", () => ({ projectGroupsClient: clientMock }));

import { ProjectGroupDialogs } from "../ProjectGroupMenus";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import type { ProjectGroup } from "@shared/types/project";

const group = (id: string, position: number): ProjectGroup => ({
  id,
  name: id.toUpperCase(),
  position,
  sortMode: "mostUsed",
  createdAt: position,
});

describe("project group dialogs", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    useProjectGroupsStore.setState({ groups: [group("a", 0), group("b", 1)], dialog: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists every group with its actions, ends disabled", () => {
    useProjectGroupsStore.setState({ dialog: { kind: "manage" } });
    render(<ProjectGroupDialogs />);
    expect(screen.getByText("Manage groups")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move A up" }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(
      (screen.getByRole("button", { name: "Move B down" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Move A down" }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it("returns to Manage groups when a rename opened from it closes", () => {
    useProjectGroupsStore.setState({ dialog: { kind: "manage" } });
    render(<ProjectGroupDialogs />);
    fireEvent.click(screen.getByRole("button", { name: "Rename A" }));
    expect(useProjectGroupsStore.getState().dialog).toEqual({
      kind: "rename",
      groupId: "a",
      returnTo: "manage",
    });
    act(() => useProjectGroupsStore.getState().closeDialog());
    expect(useProjectGroupsStore.getState().dialog).toEqual({ kind: "manage" });
  });

  it("closes outright when a rename wasn't opened from Manage groups", () => {
    useProjectGroupsStore.setState({ dialog: { kind: "rename", groupId: "a" } });
    act(() => useProjectGroupsStore.getState().closeDialog());
    expect(useProjectGroupsStore.getState().dialog).toBeNull();
  });

  it("creates a group from the name typed and files the project into it", async () => {
    clientMock.create.mockResolvedValue(group("new", 2));
    clientMock.setMembership.mockResolvedValue({});
    useProjectGroupsStore.setState({ dialog: { kind: "create", projectId: "p1" } });
    render(<ProjectGroupDialogs />);
    const input = screen.getByTestId("project-group-name-input");
    fireEvent.change(input, { target: { value: "  Crisp Vector " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(useProjectGroupsStore.getState().dialog).toBeNull());
    expect(clientMock.create).toHaveBeenCalledWith("Crisp Vector");
    expect(clientMock.setMembership).toHaveBeenCalledWith("p1", "new");
  });

  it("shows the host's refusal inline and keeps the dialog open", async () => {
    clientMock.create.mockRejectedValue(new Error('A group called "a" already exists'));
    useProjectGroupsStore.setState({ dialog: { kind: "create" } });
    render(<ProjectGroupDialogs />);
    const input = screen.getByTestId("project-group-name-input");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(useProjectGroupsStore.getState().dialog).toEqual({ kind: "create" });
  });

  it("recomputes a group move from the current list on every attempt", async () => {
    clientMock.reorder
      .mockRejectedValueOnce(new Error("The group list changed — try again"))
      .mockImplementation((ids: string[]) =>
        Promise.resolve(ids.map((id, position) => group(id, position)))
      );
    await act(() => useProjectGroupsStore.getState().moveGroup("b", -1));
    expect(clientMock.reorder).toHaveBeenLastCalledWith(["b", "a"]);
    // Another window adds a group before the user retries.
    useProjectGroupsStore.setState({ groups: [group("a", 0), group("b", 1), group("c", 2)] });
    await act(() => useProjectGroupsStore.getState().moveGroup("b", -1));
    expect(clientMock.reorder).toHaveBeenLastCalledWith(["b", "a", "c"]);
  });

  it("keeps focus on the moved group when its button disables at an end", async () => {
    clientMock.reorder.mockImplementation((ids: string[]) =>
      Promise.resolve(ids.map((id, position) => group(id, position)))
    );
    useProjectGroupsStore.setState({ dialog: { kind: "manage" } });
    render(<ProjectGroupDialogs />);
    const down = screen.getByRole("button", { name: "Move A down" });
    down.focus();
    fireEvent.click(down);
    // A is now last: its down button is disabled, so focus moves to its up button.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move A up" }))
    );
  });

  it("goes back to Manage groups when the group being renamed is deleted elsewhere", async () => {
    useProjectGroupsStore.setState({
      dialog: { kind: "rename", groupId: "a", returnTo: "manage" },
    });
    render(<ProjectGroupDialogs />);
    act(() => useProjectGroupsStore.setState({ groups: [group("b", 0)] }));
    await waitFor(() =>
      expect(useProjectGroupsStore.getState().dialog).toEqual({ kind: "manage" })
    );
  });
});
