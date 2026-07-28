// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { CodeForgeTab } from "../CodeForgeTab";
import type { RemoteInfo } from "@shared/types/ipc/forge";

let provenanceCallbacks: Array<() => void>;
let getForgeProvidersMock: ReturnType<typeof vi.fn>;
let remotes: RemoteInfo[];

beforeEach(() => {
  provenanceCallbacks = [];
  remotes = [];
  getForgeProvidersMock = vi.fn(async () => []);
  window.electron = {
    project: {
      listRemotes: vi.fn(async () => remotes),
    },
    plugin: {
      getForgeProviders: getForgeProvidersMock,
      onProvenanceChanged: vi.fn((callback: () => void) => {
        provenanceCallbacks.push(callback);
        return () => {
          provenanceCallbacks = provenanceCallbacks.filter((cb) => cb !== callback);
        };
      }),
    },
  } as unknown as typeof window.electron;
});

function renderCodeForgeTab(forgeRemote?: string) {
  return render(
    <CodeForgeTab
      forgeRemote={forgeRemote}
      onForgeRemoteChange={vi.fn()}
      forgeProviderOverride={null}
      onForgeProviderOverrideChange={vi.fn()}
      projectPath="/Users/test/Projects/sample"
    />
  );
}

function makeRemote(name: string): RemoteInfo {
  return { name, fetchUrl: `git@github.com:acme/${name}.git`, parsedRepo: null };
}

function remoteSelect(container: HTMLElement): HTMLSelectElement {
  const select = container.querySelector("#project-code-forge-remote select");
  if (!select) throw new Error("remote select not rendered");
  return select as HTMLSelectElement;
}

function optionAt(select: HTMLSelectElement, index: number): HTMLOptionElement {
  const option = select.options[index];
  if (!option) throw new Error(`no option at index ${index}`);
  return option;
}

describe("CodeForgeTab — DOM anchors for settings deep-links", () => {
  it("exposes the project-code-forge-remote anchor for settings deep-links", async () => {
    const { container } = renderCodeForgeTab();
    await waitFor(() => {
      expect(container.querySelector("#project-code-forge-remote")).not.toBeNull();
    });
  });
});

describe("CodeForgeTab — stale forge remote", () => {
  it("keeps a saved remote that no longer exists selectable and distinct from auto-detect", async () => {
    remotes = [makeRemote("origin")];
    const { container } = renderCodeForgeTab("upstream");

    await waitFor(() => {
      expect(remoteSelect(container).options).toHaveLength(3);
    });

    const select = remoteSelect(container);
    // The stale name stays the selected value instead of silently collapsing
    // onto the auto-detect option, and its label says why it can't be used.
    expect(select.value).toBe("upstream");
    const selected = optionAt(select, select.selectedIndex);
    expect(selected.value).toBe("upstream");
    expect(selected.textContent).not.toBe(optionAt(select, 0).textContent);
    expect(selected.textContent).toContain("upstream");
    expect(selected.textContent).toMatch(/unavailable/i);
  });

  it("adds no extra option when the saved remote is still present", async () => {
    remotes = [makeRemote("origin"), makeRemote("upstream")];
    const { container } = renderCodeForgeTab("upstream");

    await waitFor(() => {
      expect(remoteSelect(container).options).toHaveLength(3);
    });

    const select = remoteSelect(container);
    expect(select.value).toBe("upstream");
    expect(optionAt(select, select.selectedIndex).textContent).not.toMatch(/unavailable/i);
  });

  it("adds no extra option when no remote is saved", async () => {
    remotes = [makeRemote("origin")];
    const { container } = renderCodeForgeTab(undefined);

    await waitFor(() => {
      expect(remoteSelect(container).options).toHaveLength(2);
    });
    expect(remoteSelect(container).value).toBe("");
  });
});

describe("CodeForgeTab — live forge-provider refresh", () => {
  it("refetches providers when plugin provenance changes (live enable/disable)", async () => {
    renderCodeForgeTab();
    await waitFor(() => {
      expect(getForgeProvidersMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      provenanceCallbacks.forEach((cb) => cb());
    });

    await waitFor(() => {
      expect(getForgeProvidersMock).toHaveBeenCalledTimes(2);
    });
  });

  it("unsubscribes from provenance changes on unmount", async () => {
    const { unmount } = renderCodeForgeTab();
    await waitFor(() => {
      expect(provenanceCallbacks).toHaveLength(1);
    });

    unmount();
    expect(provenanceCallbacks).toHaveLength(0);
  });
});
