// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { useContext, type ReactElement, type ReactNode } from "react";
import { SettingsValidationProvider } from "@/components/Settings/SettingsValidationRegistry";
import {
  SettingsFlushContext,
  SettingsFlushProvider,
} from "@/components/Settings/SettingsFlushRegistry";

// The editor reports errors to the sidebar and registers a close-time flush, both
// through the dialog's registries.
function Providers({ children }: { children: ReactNode }) {
  return (
    <SettingsValidationProvider>
      <SettingsFlushProvider>{children}</SettingsFlushProvider>
    </SettingsValidationProvider>
  );
}
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: Providers });
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

      expect(screen.getByText("Inherited from global")).toBeTruthy();
      expect(screen.getByText("API_URL")).toBeTruthy();
      expect(screen.getByText("NODE_ENV")).toBeTruthy();

      const globalBadges = screen.getAllByText("Global");
      expect(globalBadges.length).toBe(2);
    });

    it("does not render inherited section when globalEnvironmentVariables is undefined", () => {
      render(<EnvironmentVariablesEditor {...defaultProps} />);

      expect(screen.queryByText("Inherited from global")).toBeNull();
    });

    it("does not render inherited section when globalEnvironmentVariables is empty", () => {
      render(<EnvironmentVariablesEditor {...defaultProps} globalEnvironmentVariables={{}} />);

      expect(screen.queryByText("Inherited from global")).toBeNull();
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

      expect(screen.getByText("Inherited from global")).toBeTruthy();
      expect(screen.getByText("API_KEY")).toBeTruthy();

      const globalSection = screen.getByRole("group", { name: "Inherited from global" });
      const deleteButtons = globalSection.querySelectorAll('[aria-label^="Delete"]');
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

      expect(screen.getByText("Inherited from global")).toBeTruthy();

      const nameInputs = screen.getAllByLabelText("Environment variable name");
      expect(nameInputs.length).toBe(1);
      expect((nameInputs[0] as HTMLInputElement).value).toBe("MY_VAR");

      const valueInputs = screen.getAllByLabelText("Environment variable value");
      expect(valueInputs.length).toBe(1);
      expect((valueInputs[0] as HTMLInputElement).value).toBe("my-value");

      const deleteButtons = screen.getAllByRole("button", { name: /^Delete / });
      expect(deleteButtons.length).toBe(1);
    });

    it("sorts global entries alphabetically", () => {
      render(
        <EnvironmentVariablesEditor
          {...defaultProps}
          globalEnvironmentVariables={{ ZEBRA: "z", APPLE: "a", MANGO: "m" }}
        />
      );

      const globalSection = screen.getByRole("group", { name: "Inherited from global" });
      const textContent = globalSection.textContent!;
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

      expect(screen.getByText("••••••••")).toBeTruthy();
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
      expect(screen.getByText(/fix the name above to save/i)).toBeTruthy();
    });
  });
});

describe("EnvironmentVariablesEditor — DOM anchors for settings deep-links", () => {
  it("exposes the project-env-vars anchor for settings deep-links", () => {
    const { container } = render(<EnvironmentVariablesEditor {...defaultProps} />);
    expect(container.querySelector("#project-env-vars")).not.toBeNull();
  });
});

describe("EnvironmentVariablesEditor save controls", () => {
  it("keeps Save and Discard disabled until the draft differs from what was loaded", () => {
    render(
      <EnvironmentVariablesEditor
        {...defaultProps}
        environmentVariables={[makeEnvVar("MY_VAR", "a")]}
        onFlush={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const discard = screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(discard.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Environment variable value"), {
      target: { value: "b" },
    });
    expect(save.disabled).toBe(false);
    expect(discard.disabled).toBe(false);

    fireEvent.click(discard);
    expect(save.disabled).toBe(true);
  });
});

describe("EnvironmentVariablesEditor close-time flush", () => {
  // Matches the global Environment page: closing Settings keeps a valid draft
  // rather than silently dropping it, and never stores an invalid one.
  let flushAll: (() => Promise<void>) | undefined;
  function CaptureFlush() {
    flushAll = useContext(SettingsFlushContext)?.flushAll;
    return null;
  }

  const renderEditor = (onChange: (value: EnvVar[]) => void, onFlush: () => Promise<void>) =>
    render(
      <>
        <CaptureFlush />
        <EnvironmentVariablesEditor
          {...defaultProps}
          environmentVariables={[makeEnvVar("MY_VAR", "a")]}
          onEnvironmentVariablesChange={onChange}
          onFlush={onFlush}
        />
      </>
    );

  it("saves a valid draft when the dialog flushes", async () => {
    const onChange = vi.fn<(value: EnvVar[]) => void>();
    const onFlush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    renderEditor(onChange, onFlush);
    fireEvent.change(screen.getByLabelText("Environment variable value"), {
      target: { value: "b" },
    });
    await flushAll!();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0]).toMatchObject({ key: "MY_VAR", value: "b" });
    expect(onFlush).toHaveBeenCalled();
  });

  it("does not store a draft with an invalid name when the dialog flushes", async () => {
    const onChange = vi.fn<(value: EnvVar[]) => void>();
    const onFlush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    renderEditor(onChange, onFlush);
    fireEvent.change(screen.getByLabelText("Environment variable name"), {
      target: { value: "1BAD" },
    });
    await flushAll!();
    expect(onChange).not.toHaveBeenCalled();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("registers nothing while the draft is clean", async () => {
    const onChange = vi.fn<(value: EnvVar[]) => void>();
    renderEditor(onChange, vi.fn<() => Promise<void>>().mockResolvedValue(undefined));
    await flushAll!();
    expect(onChange).not.toHaveBeenCalled();
  });
});
