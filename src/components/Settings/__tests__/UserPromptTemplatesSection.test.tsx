// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserPromptTemplatesSnapshot } from "@shared/types/ipc/userPromptTemplates";
import { _resetHostPlatformForTests, setHostPlatformInfo } from "@/hooks/useHostPlatform";
import {
  _resetUserPromptTemplateStoreForTest,
  useUserPromptTemplateStore,
} from "@/store/userPromptTemplateStore";
import { UserPromptTemplatesSection } from "../UserPromptTemplatesSection";

const DIRECTORY = "/home/me/.daintree/templates";

function snapshot(partial: Partial<UserPromptTemplatesSnapshot> = {}): UserPromptTemplatesSnapshot {
  return { directory: DIRECTORY, templates: [], problems: [], ...partial };
}

const list = vi.fn<() => Promise<UserPromptTemplatesSnapshot>>();
const openFolder = vi.fn();

async function renderSection() {
  render(<UserPromptTemplatesSection />);
  await act(async () => {});
}

beforeEach(() => {
  _resetUserPromptTemplateStoreForTest();
  list.mockReset().mockResolvedValue(snapshot());
  openFolder.mockReset().mockResolvedValue({ directory: DIRECTORY, opened: true });
  Reflect.set(window, "electron", {
    userPromptTemplates: { list, openFolder },
    remoteHosts: { isInUse: vi.fn().mockResolvedValue(false) },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "__DAINTREE_HOST_ID__");
  _resetHostPlatformForTests();
});

describe("UserPromptTemplatesSection", () => {
  it("names the folder once it has been read, and shows no warning for a healthy one", async () => {
    await renderSection();
    expect(screen.getByText(DIRECTORY)).toBeTruthy();
    expect(screen.queryByText("Some templates weren't loaded")).toBeNull();
    expect(useUserPromptTemplateStore.getState().directory).toBe(DIRECTORY);
  });

  it("says which files were left out and why", async () => {
    list.mockResolvedValue(
      snapshot({
        problems: [
          { fileName: "review.md", reason: "description is missing" },
          { fileName: null, reason: "Only the first 100 Markdown files in the folder are read" },
        ],
      })
    );
    await renderSection();
    expect(screen.getByText("Some templates weren't loaded")).toBeTruthy();
    expect(screen.getByText("review.md").closest("li")?.textContent).toBe(
      "review.md: description is missing"
    );
    expect(screen.getByText(/first 100 Markdown files/)).toBeTruthy();
  });

  it("reads the folder again when the window comes back, clearing a problem fixed elsewhere", async () => {
    list.mockResolvedValueOnce(
      snapshot({ problems: [{ fileName: "review.md", reason: "description is missing" }] })
    );
    await renderSection();
    expect(screen.getByText("review.md")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(screen.queryByText("review.md")).toBeNull();
  });

  it("stops listening for the window when it goes", async () => {
    await renderSection();
    list.mockClear();
    cleanup();
    window.dispatchEvent(new Event("focus"));
    expect(list).not.toHaveBeenCalled();
  });

  it("retries from the warning", async () => {
    list.mockResolvedValueOnce(
      snapshot({ problems: [{ fileName: "review.md", reason: "description is missing" }] })
    );
    await renderSection();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("review.md")).toBeNull();
  });

  it("opens the folder, and reads it again since opening may have made it", async () => {
    await renderSection();
    list.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    });
    expect(openFolder).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Couldn't open the folder/)).toBeNull();
  });

  it("says so when the folder couldn't be opened", async () => {
    openFolder.mockResolvedValue({ directory: DIRECTORY, opened: false });
    await renderSection();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open folder" }));
    });
    expect(screen.getByText(/Couldn't open the folder/)).toBeTruthy();
  });

  it("says a remote window's templates come from this machine, not the host", async () => {
    Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-01" });
    setHostPlatformInfo({ hostName: "studio-01" });
    await renderSection();
    const group = screen.getByRole("group", { name: "Prompt templates" });
    expect(group.textContent).toMatch(/read from this (Mac|PC|machine)/);
    expect(group.textContent).toContain("while you work on studio-01");
    expect(
      screen.getByRole("button", { name: /^Open folder on this (Mac|PC|machine)$/ })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open folder on studio-01" })).toBeNull();
  });

  it("doesn't mention other machines in a local window", async () => {
    await renderSection();
    const group = screen.getByRole("group", { name: "Prompt templates" });
    expect(group.textContent).not.toContain("read from");
  });
});
