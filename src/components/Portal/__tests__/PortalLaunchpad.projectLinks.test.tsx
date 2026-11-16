// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PortalLink, ProjectPortalLink } from "@shared/types";

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

import { PortalLaunchpad } from "../PortalLaunchpad";

const chat: PortalLink = {
  id: "claude",
  title: "Claude",
  url: "https://claude.ai/new",
  icon: "claude",
  type: "system",
  enabled: true,
  order: 0,
};

const staging: ProjectPortalLink = {
  id: "a",
  title: "Staging",
  url: "https://www.staging.example.com/app",
  addedByAssistant: true,
};
const prod: ProjectPortalLink = { id: "b", title: "Production", url: "https://example.com/" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PortalLaunchpad project links (#17091)", () => {
  it("lists the project's links above the chat services, each with its host", () => {
    const { container } = render(
      <PortalLaunchpad links={[chat]} projectLinks={[staging, prod]} onOpenUrl={vi.fn()} />
    );

    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toEqual(["This project", "New chat"]);
    const host = container.querySelector("#portal-link-project-a-host");
    expect(host?.textContent).toBe("staging.example.com, added by the Assistant");
    expect(container.querySelector("#portal-link-project-b-host")?.textContent).toBe(
      "example.com"
    );
  });

  it("marks only the links the Assistant added", () => {
    const { getAllByText } = render(
      <PortalLaunchpad links={[]} projectLinks={[staging, prod]} onOpenUrl={vi.fn()} />
    );

    expect(getAllByText("Assistant")).toHaveLength(1);
  });

  it("shows a project's links with no chat service, instead of the empty state", () => {
    const { container, queryByText } = render(
      <PortalLaunchpad links={[]} projectLinks={[prod]} onOpenUrl={vi.fn()} />
    );

    expect(queryByText("Add a chat service")).toBeNull();
    expect([...container.querySelectorAll("h2")].map((h) => h.textContent)).toEqual([
      "This project",
    ]);
  });

  it("opens a project link like any other, in the background on a middle click", () => {
    const onOpenUrl = vi.fn();
    const { getByText } = render(
      <PortalLaunchpad links={[chat]} projectLinks={[prod]} onOpenUrl={onOpenUrl} />
    );

    fireEvent.click(getByText("Production"));
    fireEvent(
      getByText("Production"),
      new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    );

    expect(onOpenUrl.mock.calls).toEqual([
      ["https://example.com/", "Production", false],
      ["https://example.com/", "Production", true],
    ]);
  });

  it("manages the project's links in project settings", () => {
    const { getByRole } = render(
      <PortalLaunchpad links={[chat]} projectLinks={[prod]} onOpenUrl={vi.fn()} />
    );

    fireEvent.click(getByRole("button", { name: "Manage this project's links" }));

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "project:general", sectionId: "project-portal-links" },
      { source: "user" }
    );
  });
});
