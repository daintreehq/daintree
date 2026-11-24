import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext } from "@shared/types/actions";
import type { ProjectLink } from "@shared/types";
import type { NotifyPayload } from "@/lib/notify";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const { changeMock, getSettingsMock, notifyMock } = vi.hoisted(() => ({
  changeMock: vi.fn(),
  getSettingsMock: vi.fn(),
  notifyMock: vi.fn<(payload: NotifyPayload) => string>(),
}));

vi.mock("@/store/projectSettingsStore", () => ({ changeProjectLinks: changeMock }));
vi.mock("@/clients", () => ({ projectClient: { getSettings: getSettingsMock } }));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { registerProjectLinkActions } from "../projectLinkActions";
import { UnactionableTargetError } from "../../unactionableTarget";

const staging: ProjectLink = {
  id: "link-1",
  title: "Staging",
  url: "https://staging.example.com/",
  addedByAssistant: true,
};
const prod: ProjectLink = { id: "link-2", title: "Prod", url: "https://prod.example.com/" };

function define(id: string): AnyActionDefinition {
  const actions: ActionRegistry = new Map();
  registerProjectLinkActions(actions);
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

const run = (id: string, args: unknown, ctx: Partial<ActionContext>) =>
  define(id).run(args, ctx as ActionContext);

function notice(index: number): NotifyPayload {
  const call = notifyMock.mock.calls[index];
  if (!call) throw new Error(`no notice ${index}`);
  return call[0];
}

function noticeAction(index: number, label: string) {
  const action = notice(index).action;
  if (action?.label !== label) throw new Error(`no ${label} action`);
  return action;
}

const assistant: Partial<ActionContext> = {
  projectId: "proj-1",
  dispatchSource: "agent",
  hostCallerOrigin: "assistant",
};

const writes: Array<[string, unknown, unknown]> = [
  [
    "project.links.add",
    { title: "X", url: "https://x.example.com" },
    { op: "add", title: "X", url: "https://x.example.com" },
  ],
  [
    "project.links.update",
    { id: "link-1", title: "X" },
    { op: "update", id: "link-1", title: "X" },
  ],
  ["project.links.remove", { id: "link-1" }, { op: "remove", id: "link-1" }],
];

beforeEach(() => {
  vi.clearAllMocks();
  changeMock.mockResolvedValue({ saved: true, links: [staging], link: staging });
});

describe("project.links (#17091)", () => {
  it("adds as the Assistant in the session's own project and offers an Undo", async () => {
    const result = await run(
      "project.links.add",
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
    expect(notice(0).message).toContain("staging.example.com");
    // Kept in the inbox, named for its project, so an add made while the
    // window is blurred isn't lost.
    expect(notice(0).transient).not.toBe(true);
    expect(notice(0).context?.projectId).toBe("proj-1");
  });

  it("undoes the Assistant's add only while the link is still the Assistant's", async () => {
    await run(
      "project.links.add",
      { title: "Staging", url: "https://staging.example.com" },
      assistant
    );
    changeMock.mockClear();
    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "not-added-by-assistant",
      message: "theirs",
    });

    void noticeAction(0, "Undo").onClick();
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(2));

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "remove", id: "link-1", onlyIfAddedByAssistant: true },
    });
    expect(notice(1).title).toBe("Link kept");
  });

  it.each(writes)(
    "refuses %s to every agent that isn't the Assistant, before writing",
    async (id, args) => {
      for (const ctx of [
        { projectId: "proj-1", dispatchSource: "agent" as const },
        { projectId: "proj-1", dispatchSource: "plugin" as const },
      ]) {
        await expect(run(id, args, ctx)).rejects.toBeInstanceOf(UnactionableTargetError);
      }
      expect(changeMock).not.toHaveBeenCalled();
    }
  );

  it.each(writes)("writes %s as the Assistant for the Assistant", async (id, args, change) => {
    await run(id, args, assistant);

    expect(changeMock).toHaveBeenCalledTimes(1);
    expect(changeMock.mock.calls[0]?.[0]).toEqual({
      projectId: "proj-1",
      actor: "assistant",
      change,
    });
  });

  it("routes a person's change as the user's, raising no Undo", async () => {
    changeMock.mockResolvedValueOnce({ saved: true, links: [prod], link: prod });

    const result = await run(
      "project.links.update",
      { id: "link-2", title: "Prod" },
      { projectId: "proj-1", dispatchSource: "user" }
    );

    expect(changeMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      actor: "user",
      change: { op: "update", id: "link-2", title: "Prod" },
    });
    expect(result).toEqual({ link: { ...prod, addedByAssistant: false } });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses without a project, and passes main's refusal on as unactionable", async () => {
    await expect(
      run(
        "project.links.remove",
        { id: "link-1" },
        { dispatchSource: "agent", hostCallerOrigin: "assistant" }
      )
    ).rejects.toBeInstanceOf(UnactionableTargetError);
    expect(changeMock).not.toHaveBeenCalled();

    changeMock.mockResolvedValueOnce({
      saved: false,
      code: "not-added-by-assistant",
      message: "That link was added or edited by hand, so only the user can change it",
    });
    await expect(run("project.links.remove", { id: "link-2" }, assistant)).rejects.toThrow(
      "only the user can change it"
    );
  });

  it("lists the project's links with each marker as a boolean", async () => {
    getSettingsMock.mockResolvedValueOnce({ runCommands: [], links: [staging, prod] });

    const result = await run("project.links.list", undefined, assistant);

    expect(getSettingsMock).toHaveBeenCalledWith("proj-1");
    expect(result).toEqual({ links: [staging, { ...prod, addedByAssistant: false }] });
  });

  it("keeps every tool off the palette and away from plugins", () => {
    for (const id of ["project.links.list", ...writes.map(([write]) => write)]) {
      const definition = define(id);
      expect(definition.denyPluginDispatch).toBe(true);
      expect(definition.palette?.mode).toBe("hidden");
    }
  });
});
