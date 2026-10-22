import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcast = vi.hoisted(() => vi.fn());

vi.mock("../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils.js")>()),
  broadcastToProjectRenderers: broadcast,
}));

import {
  pluginProjectPresenceNamespace,
  registerPluginProjectPresenceHandlers,
} from "../pluginProjectPresence.js";
import { ProjectPresenceTracker } from "../../../services/ProjectPresenceTracker.js";
import { CHANNELS } from "../../channels.js";

const ALPHA = "a".repeat(64);
const BETA = "b".repeat(64);

let shown: string[];
let tracker: ProjectPresenceTracker;
let unregister: () => void;

const getProjectPresence = pluginProjectPresenceNamespace.ops.getProjectPresence.handler as (
  ctx: unknown
) => unknown;

beforeEach(() => {
  broadcast.mockClear();
  shown = [];
  tracker = new ProjectPresenceTracker(() => shown);
  const register = vi.spyOn(pluginProjectPresenceNamespace, "register").mockReturnValue(() => {});
  unregister = registerPluginProjectPresenceHandlers(tracker);
  register.mockRestore();
});

afterEach(() => {
  unregister();
});

describe("plugin:project-presence-get", () => {
  it("answers for the asking view's own project", () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    shown = [BETA];
    tracker.refresh();

    expect(getProjectPresence({ projectId: ALPHA })).toEqual({
      projectId: ALPHA,
      state: "background",
    });
    expect(getProjectPresence({ projectId: BETA })).toEqual({
      projectId: BETA,
      state: "foreground",
    });
  });

  it("answers null for a view with no project, and closed for one that closed", () => {
    expect(getProjectPresence({ projectId: null })).toBeNull();
    expect(getProjectPresence({ projectId: ALPHA })).toEqual({ projectId: ALPHA, state: "closed" });
  });
});

describe("plugin:project-presence-changed", () => {
  it("pushes each change to that project's own renderers", () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    shown = [ALPHA];
    tracker.refresh();
    broadcast.mockClear();

    shown = [BETA];
    tracker.refresh();

    expect(broadcast.mock.calls).toEqual([
      [BETA, CHANNELS.PLUGIN_PROJECT_PRESENCE_CHANGED, { projectId: BETA, state: "foreground" }],
      [ALPHA, CHANNELS.PLUGIN_PROJECT_PRESENCE_CHANGED, { projectId: ALPHA, state: "background" }],
    ]);
  });

  it("stops pushing once unregistered", () => {
    unregister();
    tracker.markOpened(ALPHA);
    expect(broadcast).not.toHaveBeenCalled();
    unregister = () => {};
  });
});
