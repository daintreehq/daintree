// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOnlineOnlyFiles } from "@shared/types/onlineOnlyFiles";

const reveal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/clients/systemClient", () => ({ systemClient: { showItemInFolder: reveal } }));

const remote = vi.hoisted(() => ({ current: false }));
vi.mock("@/hooks/useHostPlatform", () => ({
  isRemoteWindow: () => remote.current,
  hostFileManagerRevealLabel: () => "Show in Finder",
}));

vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "p1" }));

import { OnlineOnlyFilesBanner } from "../OnlineOnlyFilesBanner";
import { useGlobalBannerDismissalStore } from "@/store/globalBannerDismissalStore";
import { useOnlineOnlyFilesStore } from "@/store/onlineOnlyFilesStore";
import { useProjectStore } from "@/store/projectStore";

const files = (over: Partial<ProjectOnlineOnlyFiles> = {}): ProjectOnlineOnlyFiles => ({
  projectId: "p1",
  service: "Dropbox",
  revision: 1,
  git: { files: 479, directories: 0, complete: true },
  workingTree: { files: 206, directories: 0, complete: true },
  ...over,
});

describe("OnlineOnlyFilesBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    remote.current = false;
    useGlobalBannerDismissalStore.setState({ dismissed: new Set() });
    useProjectStore.setState({ projects: [{ id: "p1", path: "/cloud/p1" }] as never });
    useOnlineOnlyFilesStore.setState({ phase: "answered", files: files(), revision: 1 });
  });

  it("shows the counts and the provider's own control", () => {
    render(<OnlineOnlyFilesBanner />);

    expect(screen.getByText("Some files aren't downloaded yet")).toBeTruthy();
    const description = screen.getByText(/hasn't downloaded/);
    expect(description.textContent).toContain("479 files in .git and 206 project files");
    expect(description.textContent).toContain("Make available offline");
  });

  it("offers no download of its own, only the way to the folder", () => {
    render(<OnlineOnlyFilesBanner />);
    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent || button.getAttribute("aria-label"));

    expect(labels.some((label) => /^download/i.test(label ?? ""))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledWith("/cloud/p1");
  });

  it("doesn't offer this machine's Finder for a remote host's path", () => {
    remote.current = true;
    render(<OnlineOnlyFilesBanner />);

    expect(screen.queryByRole("button", { name: "Show in Finder" })).toBeNull();
    expect(screen.getByText(/in Finder on the host/)).toBeTruthy();
  });

  it("dismisses for the session through the coordinator's store", () => {
    render(<OnlineOnlyFilesBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss online-only files notice" }));

    expect(useGlobalBannerDismissalStore.getState().dismissed.has("online-only-files")).toBe(true);
  });

  it("doesn't read out every change of the count", () => {
    const { container } = render(<OnlineOnlyFilesBanner />);
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("off");
  });

  it("renders nothing with nothing to report", () => {
    useOnlineOnlyFilesStore.setState({
      files: files({
        git: { files: 0, directories: 0, complete: true },
        workingTree: { files: 0, directories: 0, complete: true },
      }),
    });
    const { container } = render(<OnlineOnlyFilesBanner />);
    expect(container.firstChild).toBeNull();
  });
});
