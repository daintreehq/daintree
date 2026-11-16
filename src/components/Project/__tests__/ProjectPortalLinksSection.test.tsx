// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectPortalLink, ProjectSettings } from "@shared/types";

const { changeMock, getSettingsMock, storeState } = vi.hoisted(() => ({
  changeMock: vi.fn(),
  getSettingsMock: vi.fn(),
  storeState: {
    current: { projectId: null, settings: null } as {
      projectId: string | null;
      settings: ProjectSettings | null;
    },
  },
}));

vi.mock("@/store/projectSettingsStore", () => ({
  changeProjectPortalLinks: changeMock,
  useProjectSettingsStore: (selector: (state: typeof storeState.current) => unknown) =>
    selector(storeState.current),
}));
vi.mock("@/clients", () => ({ projectClient: { getSettings: getSettingsMock } }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { ProjectPortalLinksSection } from "../ProjectPortalLinksSection";

const staging: ProjectPortalLink = {
  id: "a",
  title: "Staging",
  url: "https://staging.example.com/",
  addedByAssistant: true,
};

function inputs(container: HTMLElement) {
  return [...container.querySelectorAll("input")];
}

beforeEach(() => {
  storeState.current = {
    projectId: "proj-1",
    settings: { runCommands: [], portalLinks: [staging] },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProjectPortalLinksSection (#17091)", () => {
  it("shows the project's links with the Assistant's marked", () => {
    const { getByText } = render(<ProjectPortalLinksSection projectId="proj-1" />);

    expect(getByText("Staging")).toBeTruthy();
    expect(getByText("staging.example.com")).toBeTruthy();
    expect(getByText("Added by Assistant")).toBeTruthy();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("adds a link by hand, as the user", async () => {
    changeMock.mockResolvedValueOnce({ saved: true, links: [], link: staging });
    const { container, getByRole } = render(<ProjectPortalLinksSection projectId="proj-1" />);
    const [title, url] = inputs(container);

    fireEvent.change(title, { target: { value: "CI" } });
    fireEvent.change(url, { target: { value: "http://10.0.0.5:8080" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add" }));
    });

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "add", title: "CI", url: "http://10.0.0.5:8080" },
    });
    expect((title as HTMLInputElement).value).toBe("");
  });

  it("keeps the draft and says why when main refuses it", async () => {
    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "invalid-url",
      message: "The URL must use http:// or https://",
    });
    const { container, getByRole, getByText } = render(
      <ProjectPortalLinksSection projectId="proj-1" />
    );
    const [title, url] = inputs(container);

    fireEvent.change(title, { target: { value: "Files" } });
    fireEvent.change(url, { target: { value: "ftp://files.example.com" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Add" }));
    });

    expect(getByText("The URL must use http:// or https://")).toBeTruthy();
    expect((title as HTMLInputElement).value).toBe("Files");
  });

  it("edits a link as the user, taking it over from the Assistant", async () => {
    changeMock.mockResolvedValueOnce({ saved: true, links: [], link: staging });
    const { container, getByRole } = render(<ProjectPortalLinksSection projectId="proj-1" />);

    fireEvent.click(getByRole("button", { name: "Edit Staging" }));
    const editTitle = inputs(container)[2];
    fireEvent.change(editTitle, { target: { value: "Staging EU" } });
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Save" }));
    });

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "update", id: "a", title: "Staging EU", url: "https://staging.example.com/" },
    });
  });

  it("reads another project's links for the page, since the store holds only this view's", async () => {
    storeState.current = { projectId: "proj-1", settings: { runCommands: [] } };
    getSettingsMock.mockResolvedValueOnce({ runCommands: [], portalLinks: [staging] });

    const { findByText } = render(<ProjectPortalLinksSection projectId="proj-2" />);

    expect(await findByText("Staging")).toBeTruthy();
    expect(getSettingsMock).toHaveBeenCalledWith("proj-2");
  });
});
