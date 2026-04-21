// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResourceEnvironmentsSection } from "../ResourceEnvironmentsSection";

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
    expect(provisionInputs[0]?.getAttribute("placeholder")).toBe("");

    const teardownInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("down -v")
    );
    expect(teardownInputs).toHaveLength(1);
    expect(teardownInputs[0]?.getAttribute("placeholder")).toBe("");

    const resumeInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("start")
    );
    expect(resumeInputs).toHaveLength(1);
    expect(resumeInputs[0]?.getAttribute("placeholder")).toBe("");

    const pauseInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("stop")
    );
    expect(pauseInputs).toHaveLength(1);
    expect(pauseInputs[0]?.getAttribute("placeholder")).toBe("");

    const statusInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("ps --format json")
    );
    expect(statusInputs).toHaveLength(1);
    expect(statusInputs[0]?.getAttribute("placeholder")).toBe("");

    const connectInputs = inputs.filter((input) =>
      (input as HTMLInputElement).value.includes("exec app bash")
    );
    expect(connectInputs).toHaveLength(1);
    expect(connectInputs[0]?.getAttribute("placeholder")).toBe("");
  });

  it("preserves help text for all command fields", () => {
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

    expect(screen.getByText("Commands to run when provisioning a remote environment")).toBeTruthy();
    expect(screen.getByText("Commands to run when destroying the environment")).toBeTruthy();
    expect(
      screen.getByText("Commands to resume a paused environment without destroying")
    ).toBeTruthy();
    expect(
      screen.getByText("Commands to pause the environment while preserving state")
    ).toBeTruthy();
    expect(screen.getByText('Must output JSON with { "status": "<string>" }')).toBeTruthy();
    expect(
      screen.getByText("Shell command for connecting (ssh, docker exec, kubectl exec)")
    ).toBeTruthy();
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

    const selector = screen.getByLabelText("Select environment");
    expect(selector).toBeTruthy();

    const options = selector.querySelectorAll("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.value).toBe("docker-local");
    expect(options[0]?.textContent).toBe("docker-local");
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

    expect(screen.getByText("Default Worktree Mode")).toBeTruthy();
    expect(screen.getByText("Default mode when creating new worktrees")).toBeTruthy();

    const localRadio = screen.getByRole("radio", { name: "Local" });
    expect((localRadio as HTMLInputElement).checked).toBe(false);

    const dockerRadio = screen.getByRole("radio", { name: "docker-local" });
    expect((dockerRadio as HTMLInputElement).checked).toBe(true);
  });
});
