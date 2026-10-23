// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginLayoutConfig } from "@shared/types/plugin";

const {
  openOfferedLayout,
  dismissLayoutOffer,
  retryLayoutSeed,
  dismissFailedLayoutSeed,
  startPluginLayoutRecipe,
  notify,
} = vi.hoisted(() => ({
  openOfferedLayout: vi.fn(async () => {}),
  dismissLayoutOffer: vi.fn(async () => {}),
  retryLayoutSeed: vi.fn(async () => {}),
  dismissFailedLayoutSeed: vi.fn(async () => {}),
  startPluginLayoutRecipe: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("@/hooks/useProjectLayoutSeed", () => ({
  openOfferedLayout,
  dismissLayoutOffer,
  retryLayoutSeed,
  dismissFailedLayoutSeed,
  selectProjectDefaultLayout: (layouts: readonly PluginLayoutConfig[]) =>
    layouts.find((layout) => layout.projectDefault === true) ?? null,
}));
vi.mock("@/services/layout/applyPluginLayout", () => ({ startPluginLayoutRecipe }));
vi.mock("@/lib/notify", () => ({ notify }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectLayoutSeedNotice } from "../ProjectLayoutSeedNotice";
import { usePluginLayoutsStore } from "@/store/pluginLayoutsStore";
import {
  _resetProjectLayoutSeedStoreForTest,
  useProjectLayoutSeedStore,
} from "@/store/projectLayoutSeedStore";

const LAYOUT: PluginLayoutConfig = {
  id: "project__p1__acme.workbench",
  pluginId: "project__p1__acme",
  pluginName: "Acme",
  name: "Workbench",
  entries: [{ target: { type: "recipe", recipeId: "acme.dev" }, location: "dock" }],
  projectDefault: true,
};

const WAITING = {
  layoutId: LAYOUT.id,
  layoutName: "Workbench",
  pluginName: "Acme",
  recipes: [
    { id: "acme.dev", name: "Dev server" },
    { id: "acme.review", name: "Review agents" },
  ],
};

function renderNotice() {
  return render(
    <TooltipProvider>
      <ProjectLayoutSeedNotice />
    </TooltipProvider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}

describe("ProjectLayoutSeedNotice (#13782)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetProjectLayoutSeedStoreForTest();
    usePluginLayoutsStore.setState({ layouts: [LAYOUT] });
  });

  afterEach(() => cleanup());

  it("offers Retry for a layout that failed or was cut short (#14106)", async () => {
    useProjectLayoutSeedStore.setState({ status: "failed" });
    renderNotice();

    expect(screen.getByText("Couldn't finish opening Acme's layout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(retryLayoutSeed).toHaveBeenCalledWith(LAYOUT);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(dismissFailedLayoutSeed).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry once the plugin no longer offers the layout", () => {
    useProjectLayoutSeedStore.setState({ status: "failed" });
    usePluginLayoutsStore.setState({ layouts: [] });
    renderNotice();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers the plugin's layout once the user has opened something", async () => {
    useProjectLayoutSeedStore.setState({ status: "offered" });
    renderNotice();

    expect(screen.getByText("Acme has a layout for this project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Acme's layout" }));
    await settle();

    expect(openOfferedLayout).toHaveBeenCalledWith(LAYOUT);
  });

  it("turns the offer down with ×", async () => {
    useProjectLayoutSeedStore.setState({ status: "offered" });
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();

    expect(dismissLayoutOffer).toHaveBeenCalledTimes(1);
    expect(openOfferedLayout).not.toHaveBeenCalled();
  });

  it.each(["pending", "settled", null, undefined] as const)(
    "offers nothing while the seed is %s",
    (status) => {
      useProjectLayoutSeedStore.setState({ status });
      const { container } = renderNotice();
      expect(container.textContent).toBe("");
    }
  );

  it("offers nothing while the plugin's layout hasn't arrived", () => {
    useProjectLayoutSeedStore.setState({ status: "offered" });
    usePluginLayoutsStore.setState({ layouts: [] });
    const { container } = renderNotice();
    expect(container.textContent).toBe("");
  });

  it("lists each waiting recipe as a Start button and starts only the one clicked", async () => {
    startPluginLayoutRecipe.mockResolvedValue({ status: "applied", panelIds: [], failures: [] });
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    renderNotice();

    expect(screen.getByText("Opened Workbench from Acme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start Dev server" }));
    await settle();

    expect(startPluginLayoutRecipe).toHaveBeenCalledTimes(1);
    expect(startPluginLayoutRecipe).toHaveBeenCalledWith(LAYOUT.id, "acme.dev", {
      dispatchSource: "user",
    });
    expect(screen.queryByRole("button", { name: "Start Dev server" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start Review agents" })).toBeTruthy();
  });

  it("keeps a recipe waiting when the user declines its confirmation", async () => {
    startPluginLayoutRecipe.mockResolvedValue({ status: "cancelled" });
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Start Dev server" }));
    await settle();

    expect(screen.getByRole("button", { name: "Start Dev server" })).toBeTruthy();
  });

  it("keeps a recipe waiting when it started nothing", async () => {
    // `recipe.run` reported the failure itself; the button is how to try again.
    startPluginLayoutRecipe.mockResolvedValue({
      status: "applied",
      panelIds: [],
      failures: ["Recipe launch failed: spawn ENOENT"],
    });
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Start Dev server" }));
    await settle();

    expect(screen.getByRole("button", { name: "Start Dev server" })).toBeTruthy();
  });

  it("reports a recipe that couldn't start, with a retry", async () => {
    startPluginLayoutRecipe.mockRejectedValue(new Error("Recipe acme.dev isn't available"));
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Start Dev server" }));
    await settle();

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Terminals not started",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );
    expect(screen.getByRole("button", { name: "Start Dev server" })).toBeTruthy();
  });

  it("drops the waiting recipes on ×", () => {
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useProjectLayoutSeedStore.getState().waiting).toBeNull();
    expect(screen.queryByText("Opened Workbench from Acme")).toBeNull();
  });

  it("hides the waiting recipes once their layout is withdrawn", () => {
    useProjectLayoutSeedStore.setState({ status: "settled", waiting: WAITING });
    usePluginLayoutsStore.setState({ layouts: [] });
    const { container } = renderNotice();
    expect(container.textContent).toBe("");
  });
});
