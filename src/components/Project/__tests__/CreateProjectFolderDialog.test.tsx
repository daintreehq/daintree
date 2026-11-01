/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { suggestProjectEmoji, DEFAULT_PROJECT_EMOJI } from "@shared/utils/projectEmoji";

const {
  createProjectFolderMock,
  openDialogMock,
  getHomeDirMock,
  getProjectTemplatesMock,
  previewProjectTemplateMock,
  logErrorMock,
} = vi.hoisted(() => ({
  createProjectFolderMock: vi.fn(),
  openDialogMock: vi.fn(),
  getHomeDirMock: vi.fn(),
  getProjectTemplatesMock: vi.fn(),
  previewProjectTemplateMock: vi.fn(),
  logErrorMock: vi.fn(),
}));

vi.mock(import("@/utils/logger"), async (importOriginal) => ({
  ...(await importOriginal()),
  logError: logErrorMock,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/clients", () => ({
  projectClient: { openDialog: openDialogMock },
  pluginClient: {
    getProjectTemplates: getProjectTemplatesMock,
    previewProjectTemplate: previewProjectTemplateMock,
  },
}));

// A native select stands in for Radix's, so a choice can be driven with a
// change event; options keep their visible text.
vi.mock("@/components/ui/select", async () => {
  const { isValidElement } = await import("react");
  const textOf = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
    return "";
  };
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      disabled?: boolean;
      children: ReactNode;
    }) => (
      <select
        aria-label="Template"
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
      <option value={value}>{textOf(children)}</option>
    ),
  };
});

vi.mock("@/store/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ createProjectFolder: createProjectFolderMock }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/AppDialog", () => {
  interface AppDialogMockProps {
    isOpen: boolean;
    children: ReactNode;
    onClose: () => void;
  }
  interface SectionProps {
    children: ReactNode;
  }

  const AppDialog = ({ isOpen, children }: AppDialogMockProps) =>
    isOpen ? <div data-testid="app-dialog">{children}</div> : null;

  AppDialog.Header = ({ children }: SectionProps) => <div>{children}</div>;
  AppDialog.Title = ({ children }: SectionProps) => <h2>{children}</h2>;
  AppDialog.CloseButton = () => <button type="button">close</button>;
  AppDialog.Body = ({ children }: SectionProps) => <div>{children}</div>;
  interface FooterAction {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }
  // Mirrors the real footer's contract: an unavailable action is aria-disabled
  // and vetoes its own click, rather than natively disabled.
  const renderAction = (action?: FooterAction) =>
    action ? (
      <button
        type="button"
        aria-disabled={action.disabled || undefined}
        onClick={() => {
          if (!action.disabled) action.onClick();
        }}
      >
        {action.label}
      </button>
    ) : null;
  AppDialog.Footer = ({
    children,
    hint,
    primaryAction,
    secondaryAction,
  }: SectionProps & {
    hint?: ReactNode;
    primaryAction?: FooterAction;
    secondaryAction?: FooterAction;
  }) => (
    <div>
      {hint}
      {children}
      {renderAction(secondaryAction)}
      {renderAction(primaryAction)}
    </div>
  );

  return { AppDialog };
});

// Render the picker inline so a selection can be driven without Radix layout.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (e: { emoji: string }) => void }) => (
    <button type="button" onClick={() => onEmojiSelect({ emoji: "🦄" })}>
      pick-unicorn
    </button>
  ),
}));

vi.mock("@/store/projectGroupsStore", () => import("@/store/__tests__/projectGroupsStoreMock"));

import { CreateProjectFolderDialog } from "../CreateProjectFolderDialog";
import { useProjectGroupsStore } from "@/store/projectGroupsStore";
import { makeProjectGroup } from "@/store/__tests__/projectGroupsStoreMock";

function emojiTrigger() {
  return screen.getByRole("button", { name: /choose project emoji/i });
}

function folderInput() {
  return screen.getByLabelText<HTMLInputElement>(/^name$/i);
}

async function renderDialog() {
  const onClose = vi.fn();
  const result = render(<CreateProjectFolderDialog isOpen={true} onClose={onClose} />);
  // The dialog resolves the home directory on open; wait for it to land, or the
  // Create button stays disabled on a missing parent path.
  await waitFor(() =>
    expect(screen.getByLabelText<HTMLInputElement>(/^location$/i).value).toBe("/Users/test")
  );
  return { onClose, ...result };
}

beforeEach(() => {
  getProjectTemplatesMock.mockResolvedValue([]);
  useProjectGroupsStore.setState({ groups: [] });
});

describe("CreateProjectFolderDialog validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("flags an invalid name as it is typed and never offers it as the destination", async () => {
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "helios:dashboard" } });

    expect(folderInput().getAttribute("aria-invalid")).toBe("true");
    const describedBy = folderInput().getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toBeTruthy();
    // Typing never interrupts: the live check is announced through the field.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTitle("/Users/test/helios:dashboard")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create folder" }).getAttribute("aria-disabled")
    ).toBe("true");
  });
});

describe("CreateProjectFolderDialog identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("shows the unset tree before a folder name is typed", async () => {
    await renderDialog();
    expect(emojiTrigger().textContent).toBe(DEFAULT_PROJECT_EMOJI);
  });

  it("updates the suggestion as the folder name changes", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "docs" } });
    const forDocs = emojiTrigger().textContent;
    fireEvent.change(folderInput(), { target: { value: "mobile" } });

    expect(emojiTrigger().textContent).not.toBe(forDocs);
    expect(emojiTrigger().textContent).toBe(suggestProjectEmoji("mobile"));
  });

  it("stops re-suggesting once the user picks explicitly", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "docs" } });
    fireEvent.click(screen.getByText("pick-unicorn"));
    expect(emojiTrigger().textContent).toBe("🦄");

    // A later rename must not clobber the deliberate choice.
    fireEvent.change(folderInput(), { target: { value: "mobile" } });
    expect(emojiTrigger().textContent).toBe("🦄");
  });

  it("submits the folder name together with the explicitly chosen emoji", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });
    fireEvent.click(screen.getByText("pick-unicorn"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith("/Users/test", "my-api", "🦄", {
      disposition: "current",
    });
  });

  it("submits the suggested emoji when the user leaves it alone", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "current" }
    );
  });
});

describe("CreateProjectFolderDialog project group", () => {
  // The suite's select stand-in labels every select "Template"; with no
  // templates offered, the group picker is the only select on screen.
  const groupSelect = () => screen.queryByRole<HTMLSelectElement>("combobox");

  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  async function create(): Promise<void> {
    fireEvent.change(folderInput(), { target: { value: "my-api" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });
  }

  it("offers no group row while no groups exist", async () => {
    await renderDialog();
    expect(groupSelect()).toBeNull();
  });

  it("files the new folder under the chosen group", async () => {
    useProjectGroupsStore.setState({
      groups: [makeProjectGroup("g1", "Daintree"), makeProjectGroup("g2", "Clients", 1)],
    });
    await renderDialog();

    expect(groupSelect()?.value).toBe("no-group");
    fireEvent.change(groupSelect()!, { target: { value: "g2" } });
    await create();

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "current", groupId: "g2" }
    );
  });

  it("sends no group when the chosen one is deleted while the dialog is open", async () => {
    useProjectGroupsStore.setState({
      groups: [makeProjectGroup("g1", "Daintree"), makeProjectGroup("g2", "Clients", 1)],
    });
    await renderDialog();
    fireEvent.change(groupSelect()!, { target: { value: "g1" } });

    act(() => {
      useProjectGroupsStore.setState({ groups: [makeProjectGroup("g2", "Clients")] });
    });
    expect(groupSelect()?.value).toBe("no-group");
    await create();

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "current" }
    );
  });

  it("starts from no group each time it opens", async () => {
    useProjectGroupsStore.setState({ groups: [makeProjectGroup("g1", "Daintree")] });
    const { onClose, rerender } = await renderDialog();
    fireEvent.change(groupSelect()!, { target: { value: "g1" } });

    rerender(<CreateProjectFolderDialog isOpen={false} onClose={onClose} />);
    rerender(<CreateProjectFolderDialog isOpen={true} onClose={onClose} />);

    await waitFor(() => expect(groupSelect()?.value).toBe("no-group"));
  });
});

describe("CreateProjectFolderDialog destination (#12594)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("asks where the project opens before creating it, defaulting to this window", async () => {
    await renderDialog();

    const group = screen.getByRole("radiogroup", { name: "Open in" });
    const thisWindow = screen.getByRole("radio", { name: "This window" });
    expect(group.contains(thisWindow)).toBe(true);
    expect(thisWindow.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "New window" }).getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("carries a New window choice into the create call", async () => {
    await renderDialog();

    fireEvent.change(folderInput(), { target: { value: "my-api" } });
    fireEvent.click(screen.getByRole("radio", { name: "New window" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^create folder$/i }));
    });

    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-api",
      suggestProjectEmoji("my-api"),
      { disposition: "new" }
    );
  });

  it("starts the next open back on this window", async () => {
    const { rerender } = await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "New window" }));

    rerender(<CreateProjectFolderDialog isOpen={false} onClose={vi.fn()} />);
    rerender(<CreateProjectFolderDialog isOpen={true} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "This window" }).getAttribute("aria-checked")).toBe(
        "true"
      )
    );
  });
});

describe("CreateProjectFolderDialog project templates (#13825)", () => {
  const SITE = {
    pluginId: "acme.sites",
    pluginName: "Acme Sites",
    templateId: "site",
    title: "Static site",
    description: "A site with a build recipe.",
    iconId: "globe",
  };
  const BLOG = { ...SITE, templateId: "blog", title: "Blog", description: "A blog." };
  const sitePreview = {
    status: "ready" as const,
    digest: "site-digest",
    totalBytes: 2048,
    files: [
      { path: ".daintree/plugins/site-tools/plugin.json", size: 512, kind: "project-plugin" },
      { path: "AGENTS.md", size: 512, kind: "instructions" },
      { path: "src/main.ts", size: 1024, kind: "file" },
    ],
  };

  function templateSelect() {
    return screen.getByRole<HTMLSelectElement>("combobox", { name: "Template" });
  }

  function createButton() {
    return screen.getByRole("button", { name: /^create folder$/i });
  }

  function chooseTemplate(index: number) {
    const option = templateSelect().options.item(index);
    if (!option) throw new Error(`No template option at ${index}`);
    fireEvent.change(templateSelect(), { target: { value: option.value } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getHomeDirMock.mockResolvedValue("/Users/test");
    createProjectFolderMock.mockResolvedValue(undefined);
    getProjectTemplatesMock.mockResolvedValue([SITE, BLOG]);
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { system: { getHomeDir: getHomeDirMock } },
    });
  });

  it("offers no template choice when no plugin contributes one", async () => {
    getProjectTemplatesMock.mockResolvedValue([]);
    await renderDialog();
    expect(screen.queryByRole("combobox", { name: "Template" })).toBeNull();
  });

  it("lists Empty folder first and selected, then each template", async () => {
    await renderDialog();
    await waitFor(() => templateSelect());

    const options = Array.from(templateSelect().options, (option) => option.textContent);
    expect(options).toEqual(["Empty folder", "Static site", "Blog"]);
    expect(templateSelect().selectedIndex).toBe(0);
    expect(previewProjectTemplateMock).not.toHaveBeenCalled();
  });

  it("lists every file a template writes, then creates from exactly that list", async () => {
    previewProjectTemplateMock.mockResolvedValue(sitePreview);
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);

    const list = await screen.findByTestId("project-template-files");
    const rows = Array.from(list.querySelectorAll("li"), (li) => li.textContent);
    expect(rows).toEqual([
      expect.stringContaining(".daintree/plugins/site-tools/plugin.json"),
      expect.stringContaining("AGENTS.md"),
      expect.stringContaining("src/main.ts"),
    ]);
    expect(rows[0]).toContain("Project plugin");
    expect(rows[1]).toContain("Instructions");
    expect(screen.getByText("A site with a build recipe.")).toBeTruthy();
    expect(previewProjectTemplateMock).toHaveBeenCalledWith("acme.sites", "site");

    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-site",
      suggestProjectEmoji("my-site"),
      {
        disposition: "current",
        template: { pluginId: "acme.sites", templateId: "site", digest: "site-digest" },
      }
    );
  });

  it("says why a template can't be used and won't create from it", async () => {
    previewProjectTemplateMock.mockResolvedValue({
      status: "unusable",
      reason:
        '".mcp.json" is agent configuration, which a template never copies into a new project.',
    });
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(".mcp.json");
    // Reading the same files again can't change a refusal.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).not.toHaveBeenCalled();
  });

  it("keeps a failed read's path and errno out of the dialog, and reads again on Retry", async () => {
    const failure = new Error(
      "EACCES: permission denied, open '/Users/me/.daintree/plugins/acme/project-templates/site/a.txt'"
    );
    let resolveRetry: (value: unknown) => void = () => {};
    previewProjectTemplateMock
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)));
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read this template's files.");
    expect(alert.textContent).not.toMatch(/EACCES|\/Users\/me/);
    expect(logErrorMock).toHaveBeenCalledWith("Couldn't preview a project template", failure);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(previewProjectTemplateMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolveRetry({ ...sitePreview, digest: "retried-digest" });
    });
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-site",
      suggestProjectEmoji("my-site"),
      {
        disposition: "current",
        template: { pluginId: "acme.sites", templateId: "site", digest: "retried-digest" },
      }
    );
  });

  it("never shows or submits a preview for a template the user has moved off", async () => {
    let resolveSite: (value: unknown) => void = () => {};
    previewProjectTemplateMock.mockImplementation((_pluginId: string, templateId: string) =>
      templateId === "site"
        ? new Promise((resolve) => (resolveSite = resolve))
        : Promise.resolve({
            status: "ready",
            digest: "blog-digest",
            totalBytes: 10,
            files: [{ path: "posts/hello.md", size: 10, kind: "file" }],
          })
    );
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-blog" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);
    chooseTemplate(2);
    await screen.findByText("posts/hello.md");
    await act(async () => {
      resolveSite(sitePreview);
    });

    expect(screen.queryByText("src/main.ts")).toBeNull();
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-blog",
      suggestProjectEmoji("my-blog"),
      {
        disposition: "current",
        template: { pluginId: "acme.sites", templateId: "blog", digest: "blog-digest" },
      }
    );
  });

  it("reads a template's files again when it is chosen again, never reusing the old list", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    previewProjectTemplateMock
      .mockResolvedValueOnce(sitePreview)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);
    await screen.findByTestId("project-template-files");
    chooseTemplate(0);
    chooseTemplate(1);

    expect(screen.queryByTestId("project-template-files")).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      resolveSecond({ ...sitePreview, digest: "fresh-digest" });
    });
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "my-site",
      suggestProjectEmoji("my-site"),
      {
        disposition: "current",
        template: { pluginId: "acme.sites", templateId: "site", digest: "fresh-digest" },
      }
    );
  });

  it("reads the files again after a create from the template fails", async () => {
    previewProjectTemplateMock
      .mockResolvedValueOnce(sitePreview)
      .mockResolvedValueOnce({ ...sitePreview, digest: "changed-digest" });
    createProjectFolderMock.mockRejectedValueOnce(
      new Error("The template's files changed after they were listed.")
    );
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());
    chooseTemplate(1);
    await screen.findByTestId("project-template-files");

    await act(async () => {
      fireEvent.click(createButton());
    });

    expect(screen.getByRole("alert").textContent).toContain("changed after they were listed");
    await waitFor(() => expect(previewProjectTemplateMock).toHaveBeenCalledTimes(2));
    await screen.findByTestId("project-template-files");
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenLastCalledWith(
      "/Users/test",
      "my-site",
      suggestProjectEmoji("my-site"),
      {
        disposition: "current",
        template: { pluginId: "acme.sites", templateId: "site", digest: "changed-digest" },
      }
    );
  });

  it.each([
    ["while its files are still being read", () => new Promise(() => {})],
    ["when it can't be used", () => Promise.resolve({ status: "unusable", reason: "Nope." })],
  ])("ignores Enter on the name %s", async (_label, preview) => {
    previewProjectTemplateMock.mockImplementation(preview);
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "my-site" } });
    await waitFor(() => templateSelect());
    chooseTemplate(1);
    await act(async () => {});

    await act(async () => {
      fireEvent.keyDown(folderInput(), { key: "Enter" });
    });
    expect(createProjectFolderMock).not.toHaveBeenCalled();
  });

  it("creates an empty folder again after switching back to Empty folder", async () => {
    previewProjectTemplateMock.mockResolvedValue(sitePreview);
    await renderDialog();
    fireEvent.change(folderInput(), { target: { value: "plain" } });
    await waitFor(() => templateSelect());

    chooseTemplate(1);
    await screen.findByTestId("project-template-files");
    chooseTemplate(0);

    expect(screen.queryByTestId("project-template-files")).toBeNull();
    await act(async () => {
      fireEvent.click(createButton());
    });
    expect(createProjectFolderMock).toHaveBeenCalledWith(
      "/Users/test",
      "plain",
      suggestProjectEmoji("plain"),
      { disposition: "current" }
    );
  });
});
