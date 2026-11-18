// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectLink, ProjectLinksChangePayload } from "@shared/types";

const { changeMock, getSettingsMock } = vi.hoisted(() => ({
  changeMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("@/store/projectSettingsStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/projectSettingsStore")>()),
  changeProjectLinks: changeMock,
}));
vi.mock("@/clients", () => ({
  projectClient: { getSettings: getSettingsMock, detectRunners: vi.fn() },
  invalidateProjectSettingsCache: vi.fn(),
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { ProjectLinksSection } from "../ProjectLinksSection";
import { PROJECT_SETTINGS_SECTIONS } from "@/components/Settings/settingsTabRegistry";
import {
  cleanupProjectSettingsStore,
  patchCachedProjectLinks,
  useProjectSettingsStore,
} from "@/store/projectSettingsStore";

const staging: ProjectLink = {
  id: "a",
  title: "Staging",
  url: "https://staging.example.com/",
  addedByAssistant: true,
};

function input(container: HTMLElement, index: number): HTMLInputElement {
  const found = container.querySelectorAll("input")[index];
  if (!found) throw new Error(`no input ${index}`);
  return found;
}

/** Main's answer to a change, landing in the store as the real change does. */
function mainAnswers(links: ProjectLink[], link: ProjectLink) {
  changeMock.mockImplementationOnce(async (payload: ProjectLinksChangePayload) => {
    patchCachedProjectLinks(payload.projectId, links);
    return { saved: true, links, link };
  });
}

beforeEach(() => {
  useProjectSettingsStore.setState({
    projectId: "proj-1",
    settings: { runCommands: [], links: [staging] },
  });
});

afterEach(() => {
  cleanup();
  cleanupProjectSettingsStore();
  vi.clearAllMocks();
  // clearAllMocks keeps queued one-shot answers, so one a test never took would land in the next.
  changeMock.mockReset();
  getSettingsMock.mockReset();
});

describe("ProjectLinksSection (#17091)", () => {
  it("shows the project's links with the Assistant's marked", () => {
    const { container, getByText } = render(<ProjectLinksSection projectId="proj-1" />);

    // The launchpad's settings link and a search hit both scroll to this anchor.
    const anchor = container.querySelector(".settings-section")?.id;
    expect(anchor).toBe("project-links");
    expect(
      (PROJECT_SETTINGS_SECTIONS["project:general"].sections ?? []).map((s) => s.id)
    ).toContain(anchor);
    expect(getByText("Staging")).toBeTruthy();
    expect(getByText("staging.example.com")).toBeTruthy();
    expect(getByText("Added by Assistant")).toBeTruthy();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("adds a link by hand, as the user, and lists it", async () => {
    const ci: ProjectLink = { id: "b", title: "CI", url: "http://10.0.0.5:8080/" };
    mainAnswers([staging, ci], ci);
    const { container, getByRole, getByText } = render(<ProjectLinksSection projectId="proj-1" />);

    fireEvent.change(input(container, 0), { target: { value: "CI" } });
    fireEvent.change(input(container, 1), { target: { value: "http://10.0.0.5:8080" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add" }));
    });

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "add", title: "CI", url: "http://10.0.0.5:8080" },
    });
    expect(getByText("CI")).toBeTruthy();
    expect(input(container, 0).value).toBe("");
  });

  it("does not add while Enter commits an IME composition, then adds on a plain Enter", async () => {
    const ci: ProjectLink = { id: "b", title: "CI", url: "http://10.0.0.5:8080/" };
    mainAnswers([staging, ci], ci);
    const { container } = render(<ProjectLinksSection projectId="proj-1" />);

    fireEvent.change(input(container, 0), { target: { value: "CI" } });
    fireEvent.change(input(container, 1), { target: { value: "http://10.0.0.5:8080" } });

    await act(async () => {
      fireEvent.keyDown(input(container, 0), { key: "Enter", isComposing: true });
      fireEvent.keyDown(input(container, 0), { key: "Enter", keyCode: 229 });
    });
    expect(changeMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(input(container, 0), { key: "Enter" });
    });
    expect(changeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft, ties the refusal to the field and moves there", async () => {
    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "invalid-url",
      message: "The URL must use http:// or https://",
    });
    const { container, getByRole, getByText } = render(<ProjectLinksSection projectId="proj-1" />);

    fireEvent.change(input(container, 0), { target: { value: "Files" } });
    fireEvent.change(input(container, 1), { target: { value: "ftp://files.example.com" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add" }));
    });

    const url = input(container, 1);
    expect(getByText("The URL must use http:// or https://")).toBeTruthy();
    expect(input(container, 0).value).toBe("Files");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    const described = (url.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described.some((text) => text.includes("The URL must use http://"))).toBe(true);
    expect(document.activeElement).toBe(url);
  });

  it("edits a link as the user, taking it over from the Assistant", async () => {
    const renamed: ProjectLink = { id: "a", title: "Staging EU", url: staging.url };
    mainAnswers([renamed], renamed);
    const { container, getByRole, getByText, queryByText } = render(
      <ProjectLinksSection projectId="proj-1" />
    );

    fireEvent.click(getByRole("button", { name: "Edit Staging" }));
    fireEvent.change(input(container, 2), { target: { value: "Staging EU" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "update", id: "a", title: "Staging EU", url: "https://staging.example.com/" },
    });
    expect(getByText("Staging EU")).toBeTruthy();
    expect(queryByText("Added by Assistant")).toBeNull();
  });

  it("reads another project's links for the page, since the store holds only this view's", async () => {
    getSettingsMock.mockResolvedValueOnce({ runCommands: [], links: [staging] });

    const { findByText } = render(<ProjectLinksSection projectId="proj-2" />);

    expect(await findByText("Staging")).toBeTruthy();
    expect(getSettingsMock).toHaveBeenCalledWith("proj-2");
  });

  it("drops a failed read's error once the page shows a project it can read", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("disk unreadable"));
    const { findByText, queryByText, rerender } = render(
      <ProjectLinksSection projectId="proj-2" />
    );
    expect(await findByText("Couldn't load the links")).toBeTruthy();

    rerender(<ProjectLinksSection projectId="proj-1" />);

    expect(queryByText("Couldn't load the links")).toBeNull();
  });

  describe("focus when a row changes mode (#17504)", () => {
    const ci: ProjectLink = { id: "b", title: "CI", url: "http://10.0.0.5:8080/" };

    beforeEach(() => {
      useProjectSettingsStore.setState({
        projectId: "proj-1",
        settings: { runCommands: [], links: [staging, ci] },
      });
    });

    // The editor's title field is the third input: the add row's two come first.
    const EDIT_TITLE = 2;
    const EDIT_URL = 3;

    function openEditor(
      getByRole: (role: string, o: { name: string }) => HTMLElement,
      title: string
    ) {
      const edit = getByRole("button", { name: `Edit ${title}` });
      edit.focus();
      fireEvent.click(edit);
    }

    it("moves focus into the title field when Edit opens the editor", () => {
      const { container, getByRole, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );

      openEditor(getByRole, "CI");

      expect(queryByRole("button", { name: "Edit CI" })).toBeNull();
      expect(document.activeElement).toBe(input(container, EDIT_TITLE));
      expect(input(container, EDIT_TITLE).value).toBe("CI");
    });

    it.each(["Staging", "CI"])(
      "returns focus to %s's own Edit button when its editor is cancelled",
      (title) => {
        const { getByRole, queryByRole } = render(<ProjectLinksSection projectId="proj-1" />);
        openEditor(getByRole, title);

        fireEvent.click(getByRole("button", { name: "Cancel" }));

        expect(queryByRole("button", { name: "Save" })).toBeNull();
        expect(document.activeElement).toBe(getByRole("button", { name: `Edit ${title}` }));
        expect(changeMock).not.toHaveBeenCalled();
      }
    );

    it("returns focus to the Edit button after a save from the Save button", async () => {
      const renamed: ProjectLink = { ...staging, title: "Staging EU" };
      mainAnswers([renamed, ci], renamed);
      const { container, getByRole, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );
      openEditor(getByRole, "Staging");
      fireEvent.change(input(container, EDIT_TITLE), { target: { value: "Staging EU" } });
      const save = getByRole("button", { name: "Save" });
      save.focus();

      await act(async () => {
        fireEvent.click(save);
      });

      expect(queryByRole("button", { name: "Save" })).toBeNull();
      expect(document.activeElement).toBe(getByRole("button", { name: "Edit Staging EU" }));
    });

    it("returns focus to the Edit button after a save from Enter in a field", async () => {
      mainAnswers([staging, ci], ci);
      const { container, getByRole, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );
      openEditor(getByRole, "CI");
      expect(document.activeElement).toBe(input(container, EDIT_TITLE));

      await act(async () => {
        fireEvent.keyDown(input(container, EDIT_TITLE), { key: "Enter" });
      });

      expect(changeMock).toHaveBeenCalledWith({
        projectId: "proj-1",
        actor: "user",
        change: { op: "update", id: "b", title: "CI", url: ci.url },
      });
      expect(queryByRole("button", { name: "Save" })).toBeNull();
      expect(document.activeElement).toBe(getByRole("button", { name: "Edit CI" }));
    });

    it("keeps focus on the field main refused, with the editor still open", async () => {
      changeMock.mockResolvedValueOnce({
        saved: false,
        code: "invalid-url",
        message: "The URL must use http:// or https://",
      });
      const { container, getByRole, getByText, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );
      openEditor(getByRole, "CI");
      fireEvent.change(input(container, EDIT_URL), { target: { value: "ftp://ci.example.com" } });
      const save = getByRole("button", { name: "Save" });
      save.focus();

      await act(async () => {
        fireEvent.click(save);
      });

      expect(getByText("The URL must use http:// or https://")).toBeTruthy();
      expect(queryByRole("button", { name: "Edit CI" })).toBeNull();
      expect(document.activeElement).toBe(input(container, EDIT_URL));
    });

    it("keeps focus on the title field when main refuses the name", async () => {
      changeMock.mockResolvedValueOnce({
        saved: false,
        code: "invalid-title",
        message: "Give the link a name",
      });
      const { container, getByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      openEditor(getByRole, "CI");
      fireEvent.change(input(container, EDIT_TITLE), { target: { value: " " } });
      input(container, EDIT_URL).focus();

      await act(async () => {
        fireEvent.keyDown(input(container, EDIT_URL), { key: "Enter" });
      });

      expect(document.activeElement).toBe(input(container, EDIT_TITLE));
    });

    it("leaves focus where the user moved it while a save was out", async () => {
      let answer!: () => void;
      changeMock.mockImplementationOnce(
        (payload: ProjectLinksChangePayload) =>
          new Promise((resolve) => {
            answer = () => {
              patchCachedProjectLinks(payload.projectId, [staging, ci]);
              resolve({ saved: true, links: [staging, ci], link: ci });
            };
          })
      );
      const { container, getByRole, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );
      openEditor(getByRole, "CI");
      await act(async () => {
        fireEvent.keyDown(input(container, EDIT_TITLE), { key: "Enter" });
      });
      const elsewhere = input(container, 0);
      elsewhere.focus();

      await act(async () => answer());

      expect(queryByRole("button", { name: "Save" })).toBeNull();
      expect(queryByRole("button", { name: "Edit CI" })).not.toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    });
  });

  describe("focus after removing a row", () => {
    const ci: ProjectLink = { id: "b", title: "CI", url: "http://10.0.0.5:8080/" };
    const docs: ProjectLink = { id: "c", title: "Docs", url: "https://docs.example.com/" };

    async function removeLink(
      getByRole: (role: string, o: { name: string }) => HTMLElement,
      queryByRole: (role: string, o: { name: string }) => HTMLElement | null,
      link: ProjectLink,
      remaining: ProjectLink[]
    ) {
      mainAnswers(remaining, link);
      const button = getByRole("button", { name: `Remove ${link.title}` });
      button.focus();
      expect(document.activeElement).toBe(button);
      await act(async () => {
        fireEvent.click(button);
      });
      expect(changeMock).toHaveBeenCalledWith({
        projectId: "proj-1",
        actor: "user",
        change: { op: "remove", id: link.id },
      });
      expect(queryByRole("button", { name: `Remove ${link.title}` })).toBeNull();
    }

    beforeEach(() => {
      useProjectSettingsStore.setState({
        projectId: "proj-1",
        settings: { runCommands: [], links: [staging, ci, docs] },
      });
    });

    it("moves focus to the next row's remove button when a middle row goes", async () => {
      const { getByRole, queryByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      await removeLink(getByRole, queryByRole, ci, [staging, docs]);
      expect(document.activeElement).toBe(getByRole("button", { name: "Remove Docs" }));
    });

    it("finds the next row's remove button when its id reads like an Edit button's key", async () => {
      // Staging's Edit button registers as "edit:a", the same string as Odd's id.
      const odd: ProjectLink = { id: "edit:a", title: "Odd", url: "https://odd.example.com/" };
      useProjectSettingsStore.setState({
        projectId: "proj-1",
        settings: { runCommands: [], links: [ci, odd, staging] },
      });
      const { getByRole, queryByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      await removeLink(getByRole, queryByRole, ci, [odd, staging]);
      expect(document.activeElement).toBe(getByRole("button", { name: "Remove Odd" }));
    });

    it("moves focus to the row before when the last row goes", async () => {
      const { getByRole, queryByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      await removeLink(getByRole, queryByRole, docs, [staging, ci]);
      expect(document.activeElement).toBe(getByRole("button", { name: "Remove CI" }));
    });

    it("moves focus to the add field when the only row goes", async () => {
      useProjectSettingsStore.setState({
        projectId: "proj-1",
        settings: { runCommands: [], links: [staging] },
      });
      const { container, getByRole, queryByRole } = render(
        <ProjectLinksSection projectId="proj-1" />
      );
      await removeLink(getByRole, queryByRole, staging, []);
      expect(document.activeElement).toBe(input(container, 0));
    });

    it("leaves focus where the user moved it while the removal was saving", async () => {
      let answer!: () => void;
      changeMock.mockImplementationOnce(
        (payload: ProjectLinksChangePayload) =>
          new Promise((resolve) => {
            answer = () => {
              patchCachedProjectLinks(payload.projectId, [staging, docs]);
              resolve({ saved: true, links: [staging, docs], link: ci });
            };
          })
      );
      const { container, getByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      await act(async () => {
        fireEvent.click(getByRole("button", { name: "Remove CI" }));
      });
      const elsewhere = input(container, 1);
      elsewhere.focus();
      await act(async () => answer());
      expect(document.activeElement).toBe(elsewhere);
    });

    it("leaves focus alone when the removal is refused", async () => {
      changeMock.mockResolvedValueOnce({ saved: false, code: "not-found", message: "Gone" });
      const { getByRole } = render(<ProjectLinksSection projectId="proj-1" />);
      const button = getByRole("button", { name: "Remove CI" });
      button.focus();
      await act(async () => {
        fireEvent.click(button);
      });
      expect(document.activeElement).toBe(button);
    });
  });
});
