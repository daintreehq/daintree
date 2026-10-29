// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { WorktreeSnapshot } from "@shared/types";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import { createWorktreeStore } from "@/store/createWorktreeStore";
import { ResourceEnvironmentsSection } from "../ResourceEnvironmentsSection";

// The real dialog portals and pulls in the app's icons; what matters here is what it is given.
vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: (props: {
    isOpen: boolean;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    confirmLabel: string;
    confirmDisabled?: boolean;
    hint?: React.ReactNode;
    onClose: () => void;
    onConfirm: () => void;
  }) =>
    props.isOpen ? (
      <div role="dialog">
        <h2>{props.title}</h2>
        <div>{props.description}</div>
        {props.children}
        <div>{props.hint}</div>
        <button onClick={props.onClose}>Cancel</button>
        <button onClick={props.onConfirm} disabled={props.confirmDisabled}>
          {props.confirmLabel}
        </button>
      </div>
    ) : null,
}));

const mockResourceEnvironments = {
  "docker-local": {
    provision: ["docker compose -p {worktree_name} up -d"],
    teardown: ["docker compose -p {worktree_name} down -v"],
    resume: ["docker compose -p {worktree_name} start"],
    pause: ["docker compose -p {worktree_name} stop"],
    status: "docker compose -p {worktree_name} ps --format json",
    connect: "docker compose -p {worktree_name} exec app bash",
    icon: "Container",
  },
};

describe("ResourceEnvironmentsSection", () => {
  it("renders with empty placeholders for all command input fields", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    const inputs = screen.getAllByRole("textbox");

    const provisionInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("up -d")
    );
    expect(provisionInputs).toHaveLength(1);
    expect(provisionInputs[0]?.getAttribute("placeholder")).toBe("e.g. docker compose up -d");

    const teardownInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("down -v")
    );
    expect(teardownInputs).toHaveLength(1);
    expect(teardownInputs[0]?.getAttribute("placeholder")).toBe("e.g. docker compose down");

    const resumeInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("start")
    );
    expect(resumeInputs).toHaveLength(1);
    expect(resumeInputs[0]?.getAttribute("placeholder")).toBe("e.g. docker unpause container");

    const pauseInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("stop")
    );
    expect(pauseInputs).toHaveLength(1);
    expect(pauseInputs[0]?.getAttribute("placeholder")).toBe("e.g. docker pause container");

    const statusInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("ps --format json")
    );
    expect(statusInputs).toHaveLength(1);
    expect(statusInputs[0]?.getAttribute("placeholder")).toBe(
      "e.g. docker compose ps --format json"
    );

    const connectInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("exec app bash")
    );
    expect(connectInputs).toHaveLength(1);
    expect(connectInputs[0]?.getAttribute("placeholder")).toBe(
      "e.g. docker exec -it container /bin/bash"
    );
  });

  it("renders environment selector when environments exist", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    // The rail's visible label is "Environment", so the select's own name has to
    // match it rather than read "Select environment" (WCAG 2.5.3).
    const selector = screen.getByLabelText("Environment");
    expect(selector).toBeTruthy();

    // A combobox showing the active environment, not a native <select>.
    expect(selector.getAttribute("role")).toBe("combobox");
    expect(selector.textContent).toContain("docker-local");
  });

  it("renders variables hint with correct formatting", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    expect(screen.getByText("Variables")).toBeTruthy();
    expect(screen.getByText(/replaced at runtime in all commands/i)).toBeTruthy();
    expect(screen.getByText("{branch}")).toBeTruthy();
    expect(screen.getByText("{worktree_name}")).toBeTruthy();

    // Token and description are ranked by weight and colour, so they have to be
    // separately styleable rather than one dash-joined run. Nothing may sit
    // between them, and the detail keeps the leading space that stops the pair
    // announcing as "{branch}branch name".
    const token = screen.getByText("{branch}");
    const description = screen.getByText("branch name");
    expect(description.previousSibling).toBe(token);
    expect(description.textContent).toMatch(/^\s/);
    expect(token.parentElement?.textContent).toBe(`${token.textContent}${description.textContent}`);
  });

  it("renders add environment button when no environments exist", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={{}}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment={undefined}
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    expect(screen.getByRole("button", { name: /add environment/i })).toBeTruthy();
  });

  it("renders default worktree mode selector", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="docker-local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    expect(screen.getByText("Default worktree mode")).toBeTruthy();
    expect(screen.getByText(/where new worktrees run/i)).toBeTruthy();

    const localRadio = screen.getByRole("radio", { name: "Local" });
    expect((localRadio as HTMLInputElement).checked).toBe(false);

    const dockerRadio = screen.getByRole("radio", { name: "docker-local" });
    expect((dockerRadio as HTMLInputElement).checked).toBe(true);
  });
});

describe("ResourceEnvironmentsSection — DOM anchors for settings deep-links", () => {
  it("exposes the legacy tab-nav-project:environments anchor for back-compat deep-links", () => {
    const { container } = render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="docker-local"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    expect(container.querySelector("#tab-nav-project\\:environments")).not.toBeNull();
  });
});

describe("ResourceEnvironmentsSection — removing an environment", () => {
  const twoEnvironments = {
    ...mockResourceEnvironments,
    cloud: { provision: ["cloud up"], teardown: ["cloud down"] },
  };

  function removeEnvironment(name: string) {
    fireEvent.click(screen.getByRole("button", { name: `Delete ${name} environment` }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove environment" }));
  }

  it("moves the default worktree mode to Local when the default environment is removed", () => {
    const onResourceEnvironmentsChange = vi.fn();
    const onDefaultWorktreeModeChange = vi.fn();
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={twoEnvironments}
        onResourceEnvironmentsChange={onResourceEnvironmentsChange}
        activeResourceEnvironment="cloud"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="cloud"
        onDefaultWorktreeModeChange={onDefaultWorktreeModeChange}
        isOpen={true}
      />
    );

    removeEnvironment("cloud");

    expect(Object.keys(onResourceEnvironmentsChange.mock.calls[0]![0])).toEqual(["docker-local"]);
    expect(onDefaultWorktreeModeChange).toHaveBeenCalledWith("local");
  });

  it("leaves the default worktree mode alone when another environment is removed", () => {
    const onDefaultWorktreeModeChange = vi.fn();
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={twoEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="cloud"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="docker-local"
        onDefaultWorktreeModeChange={onDefaultWorktreeModeChange}
        isOpen={true}
      />
    );

    removeEnvironment("cloud");

    expect(onDefaultWorktreeModeChange).not.toHaveBeenCalled();
  });

  it("shows Local as the default when the saved default names a removed environment", () => {
    render(
      <ResourceEnvironmentsSection
        resourceEnvironments={mockResourceEnvironments}
        onResourceEnvironmentsChange={vi.fn()}
        activeResourceEnvironment="docker-local"
        onActiveResourceEnvironmentChange={vi.fn()}
        defaultWorktreeMode="cloud"
        onDefaultWorktreeModeChange={vi.fn()}
        isOpen={true}
      />
    );

    expect((screen.getByRole("radio", { name: "Local" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: "docker-local" }) as HTMLInputElement).checked).toBe(
      false
    );
  });

  describe("while worktrees still run in it", () => {
    function worktree(id: string, name: string, worktreeMode: string): WorktreeSnapshot {
      return { id, worktreeId: id, path: `/repo/${name}`, name, worktreeMode } as WorktreeSnapshot;
    }

    function renderWithWorktrees(worktrees: WorktreeSnapshot[]) {
      const store = createWorktreeStore();
      store.setState({ worktrees: new Map(worktrees.map((w) => [w.id, w])) });
      const onResourceEnvironmentsChange = vi.fn();
      const onDefaultWorktreeModeChange = vi.fn();
      render(
        <WorktreeStoreContext.Provider value={store}>
          <ResourceEnvironmentsSection
            resourceEnvironments={twoEnvironments}
            onResourceEnvironmentsChange={onResourceEnvironmentsChange}
            activeResourceEnvironment="cloud"
            onActiveResourceEnvironmentChange={vi.fn()}
            defaultWorktreeMode="cloud"
            onDefaultWorktreeModeChange={onDefaultWorktreeModeChange}
            isOpen={true}
          />
        </WorktreeStoreContext.Provider>
      );
      return { store, onResourceEnvironmentsChange, onDefaultWorktreeModeChange };
    }

    it("names them and refuses to remove it", () => {
      const { onResourceEnvironmentsChange, onDefaultWorktreeModeChange } = renderWithWorktrees([
        worktree("/repo/b", "feature-b", "cloud"),
        worktree("/repo/a", "feature-a", "cloud"),
        worktree("/repo/c", "feature-c", "docker-local"),
        worktree("/repo/d", "feature-d", "local"),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Delete cloud environment" }));
      const dialog = screen.getByRole("dialog");

      expect(dialog.textContent).toContain('2 worktrees still run in "cloud"');
      const listed = within(within(dialog).getByRole("list")).getAllByRole("listitem");
      expect(listed.map((item) => item.textContent)).toEqual(["feature-a", "feature-b"]);

      const confirm = within(dialog).getByRole("button", { name: "Remove environment" });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      // The handler holds the line too, not just the disabled button.
      fireEvent.click(confirm);
      expect(onResourceEnvironmentsChange).not.toHaveBeenCalled();
      expect(onDefaultWorktreeModeChange).not.toHaveBeenCalled();
    });

    it("allows the removal once the last of them leaves the environment", () => {
      const { store, onResourceEnvironmentsChange } = renderWithWorktrees([
        worktree("/repo/a", "feature-a", "cloud"),
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Delete cloud environment" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain('1 worktree still runs in "cloud"');

      act(() => {
        store.setState({
          worktrees: new Map([["/repo/a", worktree("/repo/a", "feature-a", "local")]]),
        });
      });

      expect(within(dialog).queryByRole("list")).toBeNull();
      expect(dialog.textContent).toContain("New worktrees will start on Local");
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove environment" }));
      expect(Object.keys(onResourceEnvironmentsChange.mock.calls[0]![0])).toEqual(["docker-local"]);
    });
  });
});
