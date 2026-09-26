// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/AppDialog", () => {
  const AppDialog = ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
    isOpen ? <div>{children}</div> : null;
  AppDialog.Header = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  AppDialog.Title = ({ children }: { children: ReactNode }) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => null;
  AppDialog.Footer = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { AppDialog };
});
const pickHostPaths = vi.fn<(request: unknown) => Promise<string[] | null>>();
vi.mock("@/components/HostFilePicker/hostFilePickerQueue", () => ({
  pickHostPaths: (request: unknown) => pickHostPaths(request),
}));

import { HostAddProjectDialog } from "../HostAddProjectDialog";

const URL = "git@github.com:daintreehq/api.git";
const execute = vi.fn();
const suggestCloneDestination = vi.fn(async () => ({
  path: "/home/greg/Projects/api",
  status: "free" as const,
  detail: null,
  suggestion: null,
}));
const checkDestination = vi.fn(async ({ path }: { path: string }) => ({
  path,
  status: "free" as const,
  detail: null,
  suggestion: null,
}));

beforeEach(() => {
  execute.mockReset();
  pickHostPaths.mockReset();
  suggestCloneDestination.mockClear();
  checkDestination.mockClear();
  Object.assign(window, {
    electron: {
      hostSwitch: {
        execute,
        suggestCloneDestination,
        checkDestination,
        status: vi.fn(async () => ({ state: "running" })),
        cancel: vi.fn(async () => true),
      },
    },
  });
});

function renderDialog(onOpened = vi.fn()) {
  render(
    <HostAddProjectDialog
      hostId="studio-01"
      hostName="studio-01"
      onClose={() => {}}
      onOpened={onOpened}
    />
  );
  return onOpened;
}

describe("HostAddProjectDialog", () => {
  it("clones a URL onto that host into the folder the host suggests, then opens it", async () => {
    execute.mockResolvedValue({
      kind: "opened",
      hostId: "studio-01",
      projectId: "host-api",
      projectPath: "/home/greg/Projects/api",
      projectName: "api",
      worktreePath: null,
      canCheckOutBranch: false,
      branchNote: null,
      setupRecipeId: null,
    });
    const onOpened = renderDialog();
    const clone = screen.getByRole("button", { name: "Clone and open" }) as HTMLButtonElement;
    expect(clone.disabled).toBe(true);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Repository URL to clone on studio-01" }),
      {
        target: { value: URL },
      }
    );
    const folder = screen.getByRole("textbox", { name: "Folder on studio-01" }) as HTMLInputElement;
    await waitFor(() => expect(folder.value).toBe("/home/greg/Projects/api"));
    expect(suggestCloneDestination).toHaveBeenCalledWith({ toHostId: "studio-01", url: URL });
    await waitFor(() => expect(clone.disabled).toBe(false));
    fireEvent.click(clone);
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(execute.mock.calls[0]![0]).toMatchObject({
      kind: "clone-url",
      toHostId: "studio-01",
      url: URL,
      destination: "/home/greg/Projects/api",
      options: { submodules: false, depth: "full" },
    });
    expect(typeof execute.mock.calls[0]![0].opId).toBe("string");
  });

  it("picks the folder on that host and names the host when its clone fails", async () => {
    pickHostPaths.mockResolvedValue(["/data"]);
    execute.mockResolvedValue({
      kind: "git-failed",
      step: "clone",
      hostId: "studio-01",
      reason: "auth-failed",
      message: "Permission denied (publickey).",
    });
    const onOpened = renderDialog();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Repository URL to clone on studio-01" }),
      {
        target: { value: URL },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder on studio-01" }));
    const folder = screen.getByRole("textbox", { name: "Folder on studio-01" }) as HTMLInputElement;
    await waitFor(() => expect(folder.value).toBe("/data/api"));
    expect(pickHostPaths.mock.calls[0]![0]).toMatchObject({
      hostId: "studio-01",
      mode: "directory",
    });
    const clone = screen.getByRole("button", { name: "Clone and open" }) as HTMLButtonElement;
    await waitFor(() => expect(clone.disabled).toBe(false));
    expect(checkDestination).toHaveBeenCalledWith({
      toHostId: "studio-01",
      path: "/data/api",
      remoteUrls: [URL],
    });
    fireEvent.click(clone);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`studio-01 couldn't clone ${URL}`);
    expect(alert.textContent).toContain("Permission denied (publickey).");
    expect(onOpened).not.toHaveBeenCalled();
  });
});
