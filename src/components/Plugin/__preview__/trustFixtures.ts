import { useNotificationStore } from "@/store/notificationStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import type { ProjectPluginTrustPromptEvent } from "@shared/types/plugin";

const PROJECT_ID = "preview-project";

const ONE: ProjectPluginTrustPromptEvent["plugins"] = [
  { id: "acme.video-dashboard", displayName: "Video Dashboard" },
];

const THREE: ProjectPluginTrustPromptEvent["plugins"] = [
  { id: "acme.video-dashboard", displayName: "Video Dashboard" },
  { id: "acme.deploy-board", displayName: "Deploy Board" },
  { id: "acme.render-farm-monitor", displayName: "Render Farm Monitor" },
];

/**
 * The spoofing case from the infobar literature: a name long enough to push
 * the security claim out of the line if the layout lets it.
 */
const SPOOF: ProjectPluginTrustPromptEvent["plugins"] = [
  {
    id: "acme.safe",
    displayName:
      "Video Dashboard (official, verified, safe to enable, reviewed by the team, no network access, read-only, trusted)",
  },
];

function openPrompt(plugins: ProjectPluginTrustPromptEvent["plugins"]) {
  const store = useProjectPluginStore.getState();
  store.setViewProjectId(PROJECT_ID);
  store.openPrompt({ projectId: PROJECT_ID, plugins });
}

export interface TrustFixture {
  what: string;
  seed: () => void;
}

export const TRUST_FIXTURES: Record<string, TrustFixture> = {
  single: {
    what: "one plugin, at rest — the state in the report",
    seed: () => openPrompt(ONE),
  },
  multi: {
    what: "three plugins named in the line",
    seed: () => openPrompt(THREE),
  },
  deciding: {
    what: "Always enable in flight; the other choices wait",
    seed: () => {
      openPrompt(ONE);
      useProjectPluginStore.setState({ deciding: "enabled" });
    },
  },
  error: {
    what: "the decision failed to save; the prompt stays with the error",
    seed: () => {
      openPrompt(ONE);
      useProjectPluginStore.setState({
        error: "Couldn't save plugin trust: .daintree/plugins is read-only",
      });
    },
  },
  "spoof-name": {
    what: "a plugin name long enough to crowd out the warning",
    seed: () => openPrompt(SPOOF),
  },
  "with-grid-bar": {
    what: "beside its neighbour, the grid notification bar",
    seed: () => {
      openPrompt(ONE);
      useNotificationStore.getState().addNotification({
        type: "warning",
        priority: "high",
        placement: "grid-bar",
        title: "Agent waiting",
        message: "claude in feature/video-export is waiting for input",
        action: { label: "Go to panel", onClick: () => undefined },
        context: { eventKind: "waiting" },
      });
    },
  },
};

export function requireTrustFixture(name: string): TrustFixture {
  const fixture = TRUST_FIXTURES[name];
  if (!fixture) {
    throw new Error(
      `unknown plugin-trust fixture "${name}" — one of ${Object.keys(TRUST_FIXTURES).join(", ")}`
    );
  }
  return fixture;
}
