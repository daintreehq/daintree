// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { lazy, useCallback, useLayoutEffect, useState, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let projectSeq = 0;

/**
 * Installs the forge API. The provider list answers at once; the active project's
 * routing only when `route` or `failRouting` is called.
 */
function install({ project = true }: { project?: boolean } = {}) {
  const routing = deferred<ResolvedForgeProvider>();
  // A fresh project per test: the resolver caches by project id across mounts.
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
    failRouting: () =>
      act(async () => {
        routing.reject(new Error("resolve failed"));
      }),
  };
}

/** The dialog around the tab: its subtab memory, the pending link, the nav tab. */
function renderTab({
  sectionId = null,
  query = null,
  subtab = null,
}: {
  sectionId?: string | null;
  query?: string | null;
  subtab?: string | null;
} = {}) {
  const handled = vi.fn();
  const controls: {
    setLink?: (link: { id: string; query: string | null } | null) => void;
    setSubtab?: (subtab: string) => void;
  } = {};
  function Dialog() {
    const [activeSubtab, setActiveSubtab] = useState<string | null>(subtab);
    const [link, setLink] = useState(sectionId ? { id: sectionId, query } : null);
    useLayoutEffect(() => {
      controls.setLink = setLink;
      controls.setSubtab = setActiveSubtab;
    }, []);
    const onHandled = useCallback((id: string, landed: boolean) => {
      handled(id, landed);
      setLink(null);
    }, []);
    return (
      <SettingsValidationProvider>
        <button type="button" id="settings-tab-code-forge">
          Code forge
        </button>
        <div id="settings-panel-code-forge">
          <SettingsDeepLinkScope
            isActive
            scrollToSectionId={link?.id ?? null}
            query={link?.query ?? null}
            request={link}
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
  return {
    handled,
    /** Issues a link the way search does once the tab is already showing. */
    link: (id: string, linkQuery: string | null) =>
      act(() => controls.setLink?.({ id, query: linkQuery })),
    /** Picks a subtab the way the provider dropdown does. */
    pick: (next: string) => act(() => controls.setSubtab?.(next)),
  };
}

const shownSubtab = () => screen.getByTestId("forge-provider-selector").getAttribute("data-active");

const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
/** The element the landing scrolled to, last. */
const scrolledTo = () => scrollIntoView.mock.contexts.at(-1) as Element | undefined;
const landedIn = (testId: string) => screen.getByTestId(testId).contains(scrolledTo() ?? null);

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Element.prototype.scrollIntoView = scrollIntoView;
  slots.views.clear();
  slots.views.set("github.forgeSettingsTab", providerPanel("github", "github-token"));
  slots.views.set("gitlab.forgeSettingsTab", providerPanel("gitlab", "gitlab-auth"));
});

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

describe("CodeForgeSettingsTab deep links", () => {
  it("opens the provider the active project routes to for a credentials link", async () => {
    const { route } = install();
    const { handled } = renderTab({ sectionId: "forge-access-token", query: "token" });
    // GitHub, the first provider, would open by default; the project uses GitLab.
    await waitFor(() => expect(window.electron.forge.getProviders).toHaveBeenCalled());
    expect(handled).not.toHaveBeenCalled();

    await route(GITLAB);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(shownSubtab()).toBe(GITLAB_ID);
    expect(landedIn("gitlab-panel")).toBe(true);
  });

  it("opens the provider the search names over the one the project uses", async () => {
    const { route } = install();
    const { handled } = renderTab({ sectionId: "forge-access-token", query: "github token" });

    await route(GITLAB);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITHUB_ID);
    expect(landedIn("github-panel")).toBe(true);
  });

  it("switches an already loaded tab to the named provider before landing", async () => {
    install({ project: false });
    const { handled, link } = renderTab();
    await waitFor(() => expect(screen.getByTestId("github-panel")).toBeTruthy());

    await link("forge-access-token", "gitlab token");

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(handled).toHaveBeenCalledExactlyOnceWith("forge-access-token", true);
    expect(shownSubtab()).toBe(GITLAB_ID);
    expect(landedIn("gitlab-panel")).toBe(true);
  });

  it("keeps the provider showing when the project has no forge detected", async () => {
    const { route } = install();
    const { handled } = renderTab({ sectionId: "forge-access-token", subtab: GITLAB_ID });

    await route(null);

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITLAB_ID);
    expect(landedIn("gitlab-panel")).toBe(true);
  });

  it("falls back to the provider showing when the project's routing can't be read", async () => {
    const { failRouting } = install();
    const { handled } = renderTab({ sectionId: "forge-access-token", subtab: GITLAB_ID });
    await waitFor(() => expect(window.electron.forge.resolveProvider).toHaveBeenCalled());
    expect(handled).not.toHaveBeenCalled();

    await failRouting();

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(shownSubtab()).toBe(GITLAB_ID);
  });

  it("leaves General for the first provider when no project is open", async () => {
    install({ project: false });
    const { handled } = renderTab({ sectionId: "forge-access-token", subtab: "general" });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(shownSubtab()).toBe(GITHUB_ID);
    expect(window.electron.forge.resolveProvider).not.toHaveBeenCalled();
  });

  it("releases the link as a miss when the provider list can't load", async () => {
    install({ project: false });
    const providers = deferred<ForgeProviderEntry[]>();
    window.electron.forge.getProviders = vi.fn(() => providers.promise);
    const { handled } = renderTab({ sectionId: "forge-access-token" });
    await waitFor(() => expect(window.electron.forge.getProviders).toHaveBeenCalled());
    expect(handled).not.toHaveBeenCalled();

    await act(async () => {
      providers.reject(new Error("list failed"));
    });

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(handled).toHaveBeenCalledExactlyOnceWith("forge-access-token", false);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("waits for the provider's own panel to load in", async () => {
    const panel = deferred<{ default: ComponentType }>();
    slots.views.set(
      "github.forgeSettingsTab",
      lazy(() => panel.promise)
    );
    const { route } = install();
    const { handled } = renderTab({ sectionId: "forge-access-token" });
    await route(GITHUB);
    await waitFor(() => expect(shownSubtab()).toBe(GITHUB_ID));
    expect(handled).not.toHaveBeenCalled();

    await act(async () => {
      panel.resolve({ default: providerPanel("github", "github-token") });
    });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("forge-access-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(landedIn("github-panel")).toBe(true);
  });

  it("leaves a subtab picked while the provider's panel loads in where it is", async () => {
    const panel = deferred<{ default: ComponentType }>();
    slots.views.set(
      "gitlab.forgeSettingsTab",
      lazy(() => panel.promise)
    );
    install({ project: false });
    const { handled, pick } = renderTab({ sectionId: "forge-access-token", query: "gitlab" });
    await waitFor(() => expect(shownSubtab()).toBe(GITLAB_ID));

    await pick("general");

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(shownSubtab()).toBe("general");
    expect(handled).toHaveBeenCalledExactlyOnceWith("forge-access-token", false);
  });

  it("routes a new link to the same section afresh while the last one still waits", async () => {
    const panel = deferred<{ default: ComponentType }>();
    slots.views.set(
      "gitlab.forgeSettingsTab",
      lazy(() => panel.promise)
    );
    const { route } = install();
    const { handled, link } = renderTab({ sectionId: "forge-access-token", query: "gitlab" });
    await route(GITHUB);
    await waitFor(() => expect(shownSubtab()).toBe(GITLAB_ID));

    // Opened again for the same section, as a targeted open does, with no search words.
    await link("forge-access-token", null);

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(handled).toHaveBeenCalledExactlyOnceWith("forge-access-token", true);
    expect(shownSubtab()).toBe(GITHUB_ID);
    expect(landedIn("github-panel")).toBe(true);
  });

  it("lands a link to a provider's own row once the provider list loads", async () => {
    const providers = deferred<ForgeProviderEntry[]>();
    install();
    window.electron.forge.getProviders = vi.fn(() => providers.promise);
    const { handled } = renderTab({ sectionId: "github-token", subtab: GITHUB_ID });
    expect(handled).not.toHaveBeenCalled();

    await act(async () => {
      providers.resolve([GITHUB, GITLAB]);
    });

    await waitFor(() => expect(handled).toHaveBeenCalledWith("github-token", true));
    expect(handled).toHaveBeenCalledTimes(1);
    expect(scrolledTo()?.id).toBe("github-token");
  });

  it("opens the provider a search for the page names, then lands on the page's nav tab", async () => {
    install();
    const { handled } = renderTab({ sectionId: "tab-nav-code-forge", query: "gitlab" });

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(handled).toHaveBeenCalledExactlyOnceWith("tab-nav-code-forge", false);
    expect(shownSubtab()).toBe(GITLAB_ID);
    expect(document.activeElement?.id).toBe("settings-tab-code-forge");
  });

  it("leaves the remembered subtab for a page search that names no provider", async () => {
    install();
    const { handled } = renderTab({
      sectionId: "tab-nav-code-forge",
      query: "forge",
      subtab: "general",
    });

    await waitFor(() => expect(handled).toHaveBeenCalled());
    expect(handled).toHaveBeenCalledExactlyOnceWith("tab-nav-code-forge", false);
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
    expect(forgeCredentialsSubtab("gitlab token", options, GITHUB_ID, GITHUB_ID)).toBe(GITLAB_ID);
    expect(forgeCredentialsSubtab("token", options, GITLAB_ID, GITHUB_ID)).toBe(GITLAB_ID);
    expect(forgeCredentialsSubtab("token", options, null, GITHUB_ID)).toBe(GITHUB_ID);
  });

  it("ignores a project provider that isn't registered", () => {
    expect(forgeCredentialsSubtab(null, options, "gone.provider", GITHUB_ID)).toBe(GITHUB_ID);
  });

  it("leaves General for the first provider that can run, else the first at all", () => {
    expect(forgeCredentialsSubtab(null, options, null, "general")).toBe(GITLAB_ID);
    const noneRun = options.map((option) => ({ ...option, unavailable: true }));
    expect(forgeCredentialsSubtab(null, noneRun, null, "general")).toBe(GITHUB_ID);
    expect(forgeCredentialsSubtab(null, [], null, "general")).toBe("general");
  });
});
