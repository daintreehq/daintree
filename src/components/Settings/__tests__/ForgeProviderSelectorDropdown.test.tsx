// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ForgeProviderSelectorDropdown } from "../ForgeProviderSelectorDropdown";

afterEach(cleanup);

describe("ForgeProviderSelectorDropdown — installed plugins' providers (#15583)", () => {
  it("marks an unavailable provider in its row and still opens its subtab", async () => {
    const onSubtabChange = vi.fn();
    render(
      <ForgeProviderSelectorDropdown
        providerOptions={[
          { id: "daintree.github.github", name: "GitHub", pluginId: "daintree.github" },
          { id: "acme.gitea.gitea", name: "Gitea", pluginId: "acme.gitea", unavailable: true },
        ]}
        activeSubtab="general"
        onSubtabChange={onSubtabChange}
      />
    );

    const trigger = screen.getByTestId("forge-provider-selector-trigger");
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await screen.findByRole("combobox");

    const row = (name: string) =>
      screen.getAllByRole("option").find((o) => o.textContent?.startsWith(name));
    expect(row("Gitea")?.textContent).toContain("Unavailable");
    expect(row("GitHub")?.textContent).not.toContain("Unavailable");

    fireEvent.click(row("Gitea")!);
    expect(onSubtabChange).toHaveBeenCalledWith("acme.gitea.gitea");
  });
});
