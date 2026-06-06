// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { CodeForgeTab } from "../CodeForgeTab";

beforeEach(() => {
  window.electron = {
    project: {
      listRemotes: vi.fn(async () => []),
    },
    plugin: {
      getForgeProviders: vi.fn(async () => []),
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
