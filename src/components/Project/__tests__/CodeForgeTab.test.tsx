// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { CodeForgeTab } from "../CodeForgeTab";

let provenanceCallbacks: Array<() => void>;
let getForgeProvidersMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  provenanceCallbacks = [];
  getForgeProvidersMock = vi.fn(async () => []);
  window.electron = {
    project: {
      listRemotes: vi.fn(async () => []),
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

function renderCodeForgeTab() {
  return render(
    <CodeForgeTab
      forgeRemote={undefined}
      onForgeRemoteChange={vi.fn()}
      forgeProviderOverride={null}
      onForgeProviderOverrideChange={vi.fn()}
      projectPath="/Users/test/Projects/sample"
    />
  );
}

describe("CodeForgeTab — DOM anchors for settings deep-links", () => {
  it("exposes the project-code-forge-remote anchor for settings deep-links", async () => {
    const { container } = renderCodeForgeTab();
    await waitFor(() => {
      expect(container.querySelector("#project-code-forge-remote")).not.toBeNull();
    });
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
