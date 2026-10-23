import type { PanelStoriesMeta, PanelStory } from "@daintreehq/plugin-sdk/testing/preview";
import Settings from "../src/views/settings";

/** Request Desk's settings section: its root and its Connection page. */
export default {
  title: "Request Desk / Settings",
  component: Settings,
  args: {
    pluginId: "acme.requests",
    panelId: "settings-1",
    settingsContext: { scope: "project", projectId: "preview", page: null },
  },
  fixtures: {
    channels: {
      "connection.get": { connected: false, workspace: null },
      "connection.test": { ok: true, message: "Reached Demo workspace." },
    },
  },
} satisfies PanelStoriesMeta;

/** Not connected: the workspace field and Connect. */
export const Disconnected: PanelStory = {};

/** Connected, on the section root. */
export const Connected: PanelStory = {
  fixtures: { channels: { "connection.get": { connected: true, workspace: "Demo workspace" } } },
};

/** The Connection page. */
export const ConnectionPage: PanelStory = {
  args: { settingsContext: { scope: "project", projectId: "preview", page: "connection" } },
  fixtures: { channels: { "connection.get": { connected: true, workspace: "Demo workspace" } } },
};
