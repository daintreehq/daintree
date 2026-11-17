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
});
