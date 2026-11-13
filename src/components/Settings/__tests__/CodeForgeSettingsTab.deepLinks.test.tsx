// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { lazy, useCallback, useState, type ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeProviderEntry, Project } from "@shared/types";
import type { ResolvedForgeProvider } from "@shared/types/forge";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import {
  CodeForgeSettingsTab,
  forgeCredentialsSubtab,
  providerNamedInQuery,
} from "../CodeForgeSettingsTab";
import { SettingsDeepLinkScope } from "../SettingsDialog";
import { SettingsSection } from "../SettingsSection";
import { SettingsValidationProvider } from "../SettingsValidationRegistry";
import { useProjectStore } from "@/store";

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));

// Provider panels are plugin slot views; each test decides how they load.
const slots = vi.hoisted(() => ({ views: new Map<string, unknown>() }));
vi.mock("@/registry/builtinRendererRegistry", () => ({
  useBuiltinView: (slotId: string) => slots.views.get(slotId) ?? null,
}));
vi.mock("../ForgeIntegrationsTab", () => ({
  ForgeIntegrationsTab: () => <div data-testid="forge-integrations-tab" />,
}));
vi.mock("../ForgeProviderSelectorDropdown", () => ({
  ForgeProviderSelectorDropdown: ({ activeSubtab }: { activeSubtab: string }) => (
    <div data-testid="forge-provider-selector" data-active={activeSubtab} />
  ),
}));

function provider(pluginId: string, id: string, name: string): ForgeProviderEntry {
  return {
    pluginId,
    contribution: {
      id,
      name,
      matches: [`${id}.com`],
      slots: { settingsTab: `${id}.forgeSettingsTab` },
    },
  };
}

const GITHUB = provider("daintree.github", "github", "GitHub");
const GITLAB = provider("daintree.gitlab", "gitlab", "GitLab");
const GITHUB_ID = makeForgeProviderId(GITHUB.pluginId, GITHUB.contribution.id);
const GITLAB_ID = makeForgeProviderId(GITLAB.pluginId, GITLAB.contribution.id);

// Like the real plugin panels: an Authentication section, no `forge-access-token` id.
function providerPanel(name: string, sectionId: string): ComponentType {
  return function ProviderPanelStub() {
    return (
      <div data-testid={`${name}-panel`}>
        <SettingsSection title="Authentication" id={sectionId}>
          <input aria-label={`${name} token`} />
        </SettingsSection>
      </div>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let projectSeq = 0;

/** Installs the forge API; the active project's routing answers only when `route` is called. */
function install({ project = true }: { project?: boolean } = {}) {
  const routing = deferred<ResolvedForgeProvider>();
  const projectId = `project-${++projectSeq}`;
  window.electron = {
    forge: {
      getProviders: vi.fn(async () => [GITHUB, GITLAB]),
      resolveProvider: vi.fn(() => routing.promise),
      getCredentialStatus: vi.fn(async () => ({ hasCredential: false })),
    },
    forgeAudit: {
      getRecords: vi.fn(async () => []),
      getConfig: vi.fn(async () => ({ enabled: true, maxRecords: 500 })),
      getStats: vi.fn(async () => ({ anomalySignals: [], anomalySuppressed: true })),
    },
    plugin: { onProvenanceChanged: vi.fn(() => () => {}) },
  } as unknown as typeof window.electron;
  useProjectStore.setState({
    currentProject: project ? ({ id: projectId, name: "App", path: "/app" } as Project) : null,
  });
  return {
    route: (entry: ForgeProviderEntry | null) =>
      act(async () => {
        routing.resolve({ entry, resolvedVia: entry ? "hostname" : null });
      }),
  };
}

function renderLinked({
  sectionId,
  query = null,
  subtab = null,
}: {
  sectionId: string;
  query?: string | null;
  subtab?: string | null;
}) {
  const handled = vi.fn();
  function Dialog() {
    const [activeSubtab, setActiveSubtab] = useState<string | null>(subtab);
    const [link, setLink] = useState<string | null>(sectionId);
    const onHandled = useCallback((id: string, landed: boolean) => {
      handled(id, landed);
      setLink(null);
    }, []);
    return (
      <SettingsValidationProvider>
        <div id="settings-panel-code-forge">
          <SettingsDeepLinkScope
            isActive
            scrollToSectionId={link}
            query={query}
            onHandled={onHandled}
            tab="code-forge"
          >
            <CodeForgeSettingsTab activeSubtab={activeSubtab} onSubtabChange={setActiveSubtab} />
          </SettingsDeepLinkScope>
        </div>
      </SettingsValidationProvider>
    );
  }
  render(<Dialog />);
  return handled;
}

const shownSubtab = () => screen.getByTestId("forge-provider-selector").getAttribute("data-active");
const highlighted = () => document.querySelector(".settings-highlight");

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = vi.fn();
  slots.views.clear();
  slots.views.set("github.forgeSettingsTab", providerPanel("github", "github-token"));
  slots.views.set("gitlab.forgeSettingsTab", providerPanel("gitlab", "gitlab-auth"));
});

describe("CodeForgeSettingsTab deep links", () => {
  it("opens the provider the active project routes to for a credentials link", async () => {
    const { route } = install();
    const handled = renderLinked({ sectionId: "forge-access-token", query: "token" });
    // GitHub, the first provider, would open by default; the project uses GitLab.
    await waitFor(() => expect(window.electron.forge.getProviders).toHaveBeenCalled());
    expect(handled).not.toHaveBeenCalled();

    await route(GITLAB);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(shownSubtab()).toBe(GITLAB_ID);
    expect(screen.getByTestId("gitlab-panel").contains(highlighted())).toBe(true);
  });

  it("opens the provider the search names over the one the project uses", async () => {
    const { route } = install();
    const handled = renderLinked({ sectionId: "forge-access-token", query: "github token" });

    await route(GITLAB);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITHUB_ID);
    expect(screen.getByTestId("github-panel").contains(highlighted())).toBe(true);
  });

  it("keeps the provider showing when the project has no forge detected", async () => {
    const { route } = install();
    const handled = renderLinked({ sectionId: "forge-access-token", subtab: GITLAB_ID });

    await route(null);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITLAB_ID);
  });

  it("leaves General for the first provider when no project is open", async () => {
    install({ project: false });
    const handled = renderLinked({ sectionId: "forge-access-token", subtab: "general" });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITHUB_ID);
    expect(window.electron.forge.resolveProvider).not.toHaveBeenCalled();
  });

  it("waits for the provider's own panel to load in", async () => {
    const panel = deferred<{ default: ComponentType }>();
    slots.views.set(
      "github.forgeSettingsTab",
      lazy(() => panel.promise)
    );
    const { route } = install();
    const handled = renderLinked({ sectionId: "forge-access-token" });
    await route(GITHUB);
    await waitFor(() => expect(shownSubtab()).toBe(GITHUB_ID));
    expect(handled).not.toHaveBeenCalled();

    await act(async () => {
      panel.resolve({ default: providerPanel("github", "github-token") });
    });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("lands a link to a provider's own row once the provider list loads", async () => {
    const providers = deferred<ForgeProviderEntry[]>();
    install();
    window.electron.forge.getProviders = vi.fn(() => providers.promise);
    const handled = renderLinked({ sectionId: "github-token", subtab: GITHUB_ID });
    expect(handled).not.toHaveBeenCalled();

    await act(async () => {
      providers.resolve([GITHUB, GITLAB]);
    });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("github-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("opens the provider a search for the page names", async () => {
    install();
    const handled = renderLinked({ sectionId: "tab-nav-code-forge", query: "gitlab" });

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(shownSubtab()).toBe(GITLAB_ID);
  });

  it("leaves the remembered subtab for a page search that names no provider", async () => {
    install();
    const handled = renderLinked({
      sectionId: "tab-nav-code-forge",
      query: "forge",
      subtab: "general",
    });

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(shownSubtab()).toBe("general");
  });
});

describe("providerNamedInQuery", () => {
  const options = [
    { id: GITHUB_ID, name: "GitHub", pluginId: GITHUB.pluginId },
    { id: GITLAB_ID, name: "GitLab", pluginId: GITLAB.pluginId },
    { id: "acme.ghe", name: "GitHub Enterprise", pluginId: "acme" },
  ];

  it("matches a provider's name as whole words, in any case", () => {
    expect(providerNamedInQuery("GITLAB token", options)).toBe(GITLAB_ID);
    expect(providerNamedInQuery("git token", options)).toBeNull();
    expect(providerNamedInQuery("gitlabs", options)).toBeNull();
  });

  it("takes the longer name when one provider's name holds another's", () => {
    expect(providerNamedInQuery("token for github enterprise", options)).toBe("acme.ghe");
    expect(providerNamedInQuery("github token", options)).toBe(GITHUB_ID);
  });

  it("names nothing when two providers share the name", () => {
    const twins = [...options, { id: "other.github", name: "GitHub", pluginId: "other" }];
    expect(providerNamedInQuery("github token", twins)).toBeNull();
  });

  it("names nothing without a query", () => {
    expect(providerNamedInQuery(null, options)).toBeNull();
    expect(providerNamedInQuery("  ", options)).toBeNull();
  });
});

describe("forgeCredentialsSubtab", () => {
  const options = [
    { id: GITHUB_ID, name: "GitHub", pluginId: GITHUB.pluginId, unavailable: true },
    { id: GITLAB_ID, name: "GitLab", pluginId: GITLAB.pluginId },
  ];

  it("prefers the named provider, then the project's, then the one showing", () => {
    expect(forgeCredentialsSubtab("github", options, GITLAB_ID, "general")).toBe(GITHUB_ID);
    expect(forgeCredentialsSubtab("token", options, GITLAB_ID, GITHUB_ID)).toBe(GITLAB_ID);
    expect(forgeCredentialsSubtab("token", options, null, GITHUB_ID)).toBe(GITHUB_ID);
  });

  it("ignores a project provider that isn't registered", () => {
    expect(forgeCredentialsSubtab(null, options, "gone.provider", GITHUB_ID)).toBe(GITHUB_ID);
  });

  it("leaves General for the first provider that can run", () => {
    expect(forgeCredentialsSubtab(null, options, null, "general")).toBe(GITLAB_ID);
    expect(forgeCredentialsSubtab(null, [], null, "general")).toBe("general");
  });
});
