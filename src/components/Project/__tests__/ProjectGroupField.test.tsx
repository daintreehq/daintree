// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useOverlayState", () => ({ useOverlayState: () => {} }));
vi.mock("@/components/ui/select", () => import("@/components/ui/__tests__/nativeSelectMock"));
vi.mock("@/store/projectGroupsStore", () => import("@/store/__tests__/projectGroupsStoreMock"));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => selector({ projects: [] }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

import { AppDialog } from "@/components/ui/AppDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useProjectCreationGroup } from "@/hooks/useProjectCreationGroup";
import { ProjectGroupField } from "../ProjectGroupField";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import {
  createGroupLikeHost,
  makeProjectGroup,
} from "@/store/__tests__/projectGroupsStoreMock";

/** A creation dialog reduced to one typed field and the group row. */
function Harness({ isOpen = true, onClose = () => {} }: { isOpen?: boolean; onClose?: () => void }) {
  const { groups, groupId, setGroupId, createGroup } = useProjectCreationGroup(isOpen);
  return (
    <AppDialog isOpen={isOpen} onClose={onClose}>
      <AppDialog.Body>
        <input aria-label="Project name" defaultValue="" />
        <ProjectGroupField
          id="harness-group"
          groups={groups}
          value={groupId}
          onChange={setGroupId}
          onCreate={createGroup}
        />
        <output data-testid="chosen">{groupId ?? "none"}</output>
      </AppDialog.Body>
    </AppDialog>
  );
}

const renderHarness = (props?: Parameters<typeof Harness>[0]) =>
  render(<Harness {...props} />, { wrapper: TooltipProvider });

const newGroupButton = () => screen.getByTestId("project-group-new");
const picker = () => screen.queryByTestId<HTMLSelectElement>("project-group-field");
const chosen = () => screen.getByTestId("chosen").textContent;
const nameDialog = () => screen.getByRole("dialog", { name: "New group" });

describe("ProjectGroupField", () => {
  beforeEach(() => {
    useProjectGroupsStore.setState({ groups: [], createGroup: createGroupLikeHost });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers New group… alone while no groups exist", () => {
    renderHarness();
    expect(picker()).toBeNull();
    expect(newGroupButton().textContent).toContain("New group…");
  });

  it("makes the first group, chooses it, and hands focus to the picker", async () => {
    renderHarness();
    const projectName = screen.getByLabelText<HTMLInputElement>("Project name");
    fireEvent.change(projectName, { target: { value: "Helios" } });

    newGroupButton().focus();
    fireEvent.click(newGroupButton());
    const input = within(nameDialog()).getByTestId("project-group-name-input");
    fireEvent.change(input, { target: { value: "  Clients " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(picker()?.value).toBe("new-Clients"));
    expect(chosen()).toBe("new-Clients");
    await waitFor(() => expect(document.activeElement).toBe(picker()));
    expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
    expect(projectName.value).toBe("Helios");
  });

  it("leaves the earlier choice alone and returns to the button when cancelled", async () => {
    useProjectGroupsStore.setState({ groups: [makeProjectGroup("g1", "Daintree")] });
    renderHarness();
    fireEvent.change(picker()!, { target: { value: "g1" } });

    newGroupButton().focus();
    fireEvent.click(newGroupButton());
    fireEvent.click(within(nameDialog()).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull());
    expect(chosen()).toBe("g1");
    expect(useProjectGroupsStore.getState().groups.map((g) => g.id)).toEqual(["g1"]);
    // The creation dialog is still open under it.
    expect(screen.getByLabelText("Project name")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(newGroupButton()));
  });

  it("starts each opening with an empty name", async () => {
    renderHarness();
    fireEvent.click(newGroupButton());
    fireEvent.change(within(nameDialog()).getByTestId("project-group-name-input"), {
      target: { value: "Half typed" },
    });
    fireEvent.click(within(nameDialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull());

    fireEvent.click(newGroupButton());
    expect(
      within(nameDialog()).getByTestId<HTMLInputElement>("project-group-name-input").value
    ).toBe("");
  });

  it("shows the host's refusal inline, keeps both dialogs open, and takes a retry", async () => {
    useProjectGroupsStore.setState({
      groups: [makeProjectGroup("g1", "Daintree")],
      createGroup: (name: string) =>
        name === "Daintree"
          ? Promise.reject(new Error('A group called "Daintree" already exists'))
          : createGroupLikeHost(name),
    });
    renderHarness();
    fireEvent.click(newGroupButton());
    const input = within(nameDialog()).getByTestId("project-group-name-input");
    fireEvent.change(input, { target: { value: "Daintree" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((await within(nameDialog()).findByRole("alert")).textContent).toContain(
      "already exists"
    );
    expect(chosen()).toBe("none");
    expect(screen.getByLabelText("Project name")).toBeTruthy();

    fireEvent.change(input, { target: { value: "Daintree 2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(chosen()).toBe("new-Daintree 2"));
  });

  it("doesn't choose a group whose save lands after the dialog started over", async () => {
    let resolve!: () => void;
    useProjectGroupsStore.setState({
      createGroup: (name: string) =>
        new Promise((done) => {
          resolve = () => void createGroupLikeHost(name).then(done);
        }),
    });
    const view = renderHarness();
    fireEvent.click(newGroupButton());
    const input = within(nameDialog()).getByTestId("project-group-name-input");
    fireEvent.change(input, { target: { value: "Late" } });
    fireEvent.keyDown(input, { key: "Enter" });

    view.rerender(<Harness isOpen={false} />);
    view.rerender(<Harness isOpen={true} />);
    await act(async () => resolve());

    // The group is real now, but this opening never asked for it.
    await waitFor(() =>
      expect(useProjectGroupsStore.getState().groups.map((g) => g.id)).toEqual(["new-Late"])
    );
    expect(chosen()).toBe("none");
  });
});
