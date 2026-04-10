// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EnvironmentVariablesEditor } from "../EnvironmentVariablesEditor";
import type { EnvVar } from "../projectSettingsDirty";
import type { ProjectSettings } from "@shared/types/project";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

function makeEnvVar(key: string, value: string): EnvVar {
  return { id: `env-${key}`, key, value };
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
});
