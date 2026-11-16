import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectPortalLinksChangeResult } from "@shared/types";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const { changeMock, getSettingsMock, notifyMock } = vi.hoisted(() => ({
  changeMock: vi.fn(),
  getSettingsMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock("@/store/projectSettingsStore", () => ({ changeProjectPortalLinks: changeMock }));
vi.mock("@/clients", () => ({ projectClient: { getSettings: getSettingsMock } }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { registerProjectPortalLinkActions } from "../projectPortalLinkActions";
import { UnactionableTargetError } from "../../unactionableTarget";

const staging = {
  id: "link-1",
  title: "Staging",
  url: "https://staging.example.com/",
  addedByAssistant: true as const,
};

function define(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerProjectPortalLinkActions(actions);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

const run = (id: string, args: unknown, ctx: Partial<ActionContext>) =>
  define(id).run(args, ctx as ActionContext);

const assistant: Partial<ActionContext> = {
  projectId: "proj-1",
  dispatchSource: "agent",
  hostCallerOrigin: "assistant",
};

function saved(result: Partial<ProjectPortalLinksChangeResult> = {}) {
  return { saved: true, links: [staging], link: staging, ...result };
}

beforeEach(() => {
  vi.clearAllMocks();
  changeMock.mockResolvedValue(saved());
});

describe("portal.projectLinks (#17091)", () => {
  it("adds as the Assistant in the session's own project and offers an Undo", async () => {
    const result = await run(
      "portal.projectLinks.add",
      { title: "Staging", url: "https://staging.example.com" },
      assistant
    );

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "assistant",
      change: { op: "add", title: "Staging", url: "https://staging.example.com" },
    });
    expect(result).toEqual({ link: staging });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0].message).toContain("staging.example.com");
  });

  it("undoes the Assistant's add only while the link is still the Assistant's", async () => {
    await run(
      "portal.projectLinks.add",
      { title: "Staging", url: "https://staging.example.com" },
      assistant
    );
    changeMock.mockClear();
    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "not-added-by-assistant",
      message: "theirs",
    });

    notifyMock.mock.calls[0][0].action.onClick();
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(2));

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "remove", id: "link-1", onlyIfAddedByAssistant: true },
    });
    expect(notifyMock.mock.calls[1][0].title).toBe("Link kept");
  });

  it("refuses every agent that isn't the Daintree Assistant, before writing", async () => {
    for (const ctx of [
      { projectId: "proj-1", dispatchSource: "agent" as const },
      { projectId: "proj-1", dispatchSource: "plugin" as const },
    ]) {
      await expect(
        run("portal.projectLinks.add", { title: "X", url: "https://x.example.com" }, ctx)
      ).rejects.toBeInstanceOf(UnactionableTargetError);
      await expect(run("portal.projectLinks.remove", { id: "link-1" }, ctx)).rejects.toBeInstanceOf(
        UnactionableTargetError
      );
    }
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("changes a link for the user without marking it or raising an Undo", async () => {
    await run(
      "portal.projectLinks.update",
      { id: "link-1", title: "Staging EU" },
      { projectId: "proj-1", dispatchSource: "user" }
    );

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "update", id: "link-1", title: "Staging EU" },
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses without a project, and passes main's refusal on as unactionable", async () => {
    await expect(
      run(
        "portal.projectLinks.remove",
        { id: "link-1" },
        { dispatchSource: "agent", hostCallerOrigin: "assistant" }
      )
    ).rejects.toBeInstanceOf(UnactionableTargetError);

    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "not-added-by-assistant",
      message: "That link was added or edited by hand, so only the user can change it",
    });
    await expect(run("portal.projectLinks.remove", { id: "link-2" }, assistant)).rejects.toThrow(
      "only the user can change it"
    );
  });

  it("lists the project's links with each marker as a boolean", async () => {
    getSettingsMock.mockResolvedValueOnce({
      runCommands: [],
      portalLinks: [staging, { id: "link-2", title: "Prod", url: "https://prod.example.com/" }],
    });

    const result = await run("portal.projectLinks.list", undefined, assistant);

    expect(getSettingsMock).toHaveBeenCalledWith("proj-1");
    expect(result).toEqual({
      links: [
        staging,
        { id: "link-2", title: "Prod", url: "https://prod.example.com/", addedByAssistant: false },
      ],
    });
  });

  it("keeps every tool off the palette and away from plugins", () => {
    for (const id of [
      "portal.projectLinks.list",
      "portal.projectLinks.add",
      "portal.projectLinks.update",
      "portal.projectLinks.remove",
    ]) {
      const definition = define(id);
      expect(definition.denyPluginDispatch).toBe(true);
      expect(definition.palette?.mode).toBe("hidden");
    }
  });
});
