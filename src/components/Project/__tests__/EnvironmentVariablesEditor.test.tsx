// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EnvironmentVariablesEditor } from "../EnvironmentVariablesEditor";
import type { EnvVar } from "../projectSettingsDirty";
import type { ProjectSettings } from "@shared/types/project";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function makeEnvVar(key: string, value: string): EnvVar {
  return { id: `env-${key}`, key, value };
}

function makeSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return { runCommands: [], ...overrides };
}

const defaultProps = {
  environmentVariables: [] as EnvVar[],
  onEnvironmentVariablesChange: vi.fn(),
  settings: null as ProjectSettings | null,
  isOpen: true,
  projectLabel: "test-project",
};

describe("EnvironmentVariablesEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("inherited global variables", () => {
    it("renders inherited global vars section with Global badge when globalEnvironmentVariables provided", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          globalEnvironmentVariables={{
            API_URL: "https://api.example.com",
            NODE_ENV: "production",
          }}
        />
      );

      expect(screen.getByText("Inherited (Global)")).toBeTruthy();
      expect(screen.getByText("API_URL")).toBeTruthy();
      expect(screen.getByText("NODE_ENV")).toBeTruthy();

      const globalBadges = screen.getAllByText("Global");
      expect(globalBadges.length).toBe(2);
    });

    it("does not render inherited section when globalEnvironmentVariables is undefined", () => {
      render(<EnvironmentVariablesEditor {...defaultProps} />);

      expect(screen.queryByText("Inherited (Global)")).toBeNull();
    });

    it("does not render inherited section when globalEnvironmentVariables is empty", () => {
      render(<EnvironmentVariablesEditor {...defaultProps} globalEnvironmentVariables={{}} />);

      expect(screen.queryByText("Inherited (Global)")).toBeNull();
    });

    it("shows Overridden badge with line-through when project var overrides a global var", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("NODE_ENV", "development")]}
          globalEnvironmentVariables={{ NODE_ENV: "production", PORT: "3000" }}
        />
      );

      expect(screen.getByText("Overridden")).toBeTruthy();

      const portBadges = screen.getAllByText("Global");
      expect(portBadges.length).toBe(1);

      const nodeEnvGlobalSpan = screen.getByText("NODE_ENV");
      expect(nodeEnvGlobalSpan.className).toContain("line-through");
    });

    it("global vars are read-only (no delete button, no editable input)", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          globalEnvironmentVariables={{ API_KEY: "secret-value" }}
        />
      );

      expect(screen.getByText("Inherited (Global)")).toBeTruthy();
      expect(screen.getByText("API_KEY")).toBeTruthy();

      const globalSection = screen.getByText("Inherited (Global)").parentElement!.parentElement!;
      const deleteButtons = globalSection.querySelectorAll(
        '[aria-label="Delete environment variable"]'
      );
      expect(deleteButtons.length).toBe(0);

      const inputs = globalSection.querySelectorAll("input");
      expect(inputs.length).toBe(0);
    });

    it("project vars remain editable below the globals section", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("MY_VAR", "my-value")]}
          globalEnvironmentVariables={{ GLOBAL_VAR: "global-value" }}
        />
      );

      expect(screen.getByText("Inherited (Global)")).toBeTruthy();

      const nameInputs = screen.getAllByLabelText("Environment variable name");
      expect(nameInputs.length).toBe(1);
      expect((nameInputs[0] as HTMLInputElement).value).toBe("MY_VAR");

      const valueInputs = screen.getAllByLabelText("Environment variable value");
      expect(valueInputs.length).toBe(1);
      expect((valueInputs[0] as HTMLInputElement).value).toBe("my-value");

      const deleteButtons = screen.getAllByLabelText("Delete environment variable");
      expect(deleteButtons.length).toBe(1);
    });

    it("sorts global entries alphabetically", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          globalEnvironmentVariables={{ ZEBRA: "z", APPLE: "a", MANGO: "m" }}
        />
      );

      const globalSection = screen.getByText("Inherited (Global)").closest("div")!;
      const textContent = globalSection.parentElement!.textContent!;
      const appleIdx = textContent.indexOf("APPLE");
      const mangoIdx = textContent.indexOf("MANGO");
      const zebraIdx = textContent.indexOf("ZEBRA");
      expect(appleIdx).toBeLessThan(mangoIdx);
      expect(mangoIdx).toBeLessThan(zebraIdx);
    });

    it("masks sensitive global var values", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          globalEnvironmentVariables={{ API_KEY: "super-secret-123", PLAIN_VAR: "visible" }}
        />
      );

      expect(screen.getByText("********")).toBeTruthy();
      expect(screen.getByText("visible")).toBeTruthy();
    });

    it("can add project vars via Add Variable button even with globals present", () => {
      const onChange = vi.fn();
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          onEnvironmentVariablesChange={onChange}
          globalEnvironmentVariables={{ GLOBAL: "value" }}
        />
      );

      const addButton = screen.getByRole("button", { name: /add variable/i });
      fireEvent.click(addButton);

      const nameInputs = screen.getAllByLabelText("Environment variable name");
      expect(nameInputs.length).toBe(1);
    });
  });

  describe("copy and storage accuracy", () => {
    it("describes sensitive names as kept out of the shared settings file (not 'securely stored')", () => {
      const { container } = render(<EnvironmentVariablesEditor {...defaultProps} />);

      expect(screen.getByText(/kept out of the shared settings file/i)).toBeTruthy();
      expect(container.textContent ?? "").not.toMatch(/securely stored/i);
    });

    it("does not render the old yellow 'Insecure sensitive variables' banner", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain-value")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
          onFlush={vi.fn().mockResolvedValue(undefined)}
        />
      );

      expect(screen.queryByText(/insecure sensitive variables detected/i)).toBeNull();
      expect(screen.queryByText(/saving moves them into secure storage/i)).toBeNull();
    });

    it("labels secured rows as 'Kept out of shared settings'", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "secret-value")]}
          settings={makeSettings({ secureEnvironmentVariables: ["API_KEY"] })}
        />
      );

      expect(screen.getByLabelText("Kept out of shared settings")).toBeTruthy();
      expect(screen.queryByLabelText("Stored securely")).toBeNull();
    });

    it("labels insecure rows as 'Stored in the shared settings file'", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain-value")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
        />
      );

      expect(screen.getByLabelText("Stored in the shared settings file")).toBeTruthy();
      expect(screen.queryByLabelText("Stored in plaintext")).toBeNull();
    });
  });

  describe("migration link", () => {
    it("renders singular 'Move 1 value out of shared settings' for one insecure key", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
          onFlush={vi.fn().mockResolvedValue(undefined)}
        />
      );

      expect(
        screen.getByRole("button", { name: "Move 1 value out of shared settings" })
      ).toBeTruthy();
    });

    it("renders plural 'Move N values out of shared settings' for multiple insecure keys", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "a"), makeEnvVar("SECRET_TOKEN", "b")]}
          settings={makeSettings({
            insecureEnvironmentVariables: ["API_KEY", "SECRET_TOKEN"],
          })}
          onFlush={vi.fn().mockResolvedValue(undefined)}
        />
      );

      expect(
        screen.getByRole("button", { name: "Move 2 values out of shared settings" })
      ).toBeTruthy();
    });

    it("does not render the migration link when onFlush is undefined", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
        />
      );

      expect(screen.queryByRole("button", { name: /Move .* out of shared settings/ })).toBeNull();
    });

    it("does not render the migration link when there are no insecure keys", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          settings={makeSettings({ insecureEnvironmentVariables: [] })}
          onFlush={vi.fn().mockResolvedValue(undefined)}
        />
      );

      expect(screen.queryByRole("button", { name: /Move .* out of shared settings/ })).toBeNull();
    });

    it("calls onFlush when the migration link is clicked", async () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
          onFlush={onFlush}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Move 1 value out of shared settings" }));

      await waitFor(() => {
        expect(onFlush).toHaveBeenCalledTimes(1);
      });
    });

    it("does not migrate and surfaces a top-level error when an unrelated row is invalid", () => {
      const onFlush = vi.fn().mockResolvedValue(undefined);
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("API_KEY", "plain"), makeEnvVar("BAD-NAME", "x")]}
          settings={makeSettings({ insecureEnvironmentVariables: ["API_KEY"] })}
          onFlush={onFlush}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Move 1 value out of shared settings" }));

      expect(onFlush).not.toHaveBeenCalled();
      expect(screen.getByText(/fix the errors above before saving/i)).toBeTruthy();
    });
  });
});
