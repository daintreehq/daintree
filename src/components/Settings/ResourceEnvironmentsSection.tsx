import { useState, useMemo, useEffect } from "react";
import {
  Plus,
  X,
  ChevronUp,
  ChevronDown,
  Server,
  Cloud,
  Container,
  Cpu,
  Globe,
  Rocket,
  Database,
  Terminal,
  Box,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/utils";
import type { ResourceEnvironment } from "@shared/types/project";
import { FIELD_INPUT, FormGrid, FormRow, FormSection } from "@/components/Worktree/views";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";

interface EnvironmentSettingsTabProps {
  resourceEnvironments?: Record<string, ResourceEnvironment>;
  onResourceEnvironmentsChange: (envs: Record<string, ResourceEnvironment>) => void;
  activeResourceEnvironment?: string;
  onActiveResourceEnvironmentChange: (name: string) => void;
  defaultWorktreeMode?: string;
  onDefaultWorktreeModeChange: (mode: string) => void;
  isOpen: boolean;
}

const ENVIRONMENT_ICON_OPTIONS = [
  { name: "Server", label: "Server" },
  { name: "Cloud", label: "Cloud" },
  { name: "Container", label: "Container" },
  { name: "Cpu", label: "CPU" },
  { name: "Globe", label: "Globe" },
  { name: "Rocket", label: "Rocket" },
  { name: "Database", label: "Database" },
  { name: "Terminal", label: "Terminal" },
  { name: "Box", label: "Box" },
  { name: "Layers", label: "Layers" },
] as const;

const ICON_COMPONENTS = {
  Server,
  Cloud,
  Container,
  Cpu,
  Globe,
  Rocket,
  Database,
  Terminal,
  Box,
  Layers,
};

function CommandList({
  commands,
  onChange,
  placeholder,
  label,
  helpText,
}: {
  commands: string[];
  onChange: (commands: string[]) => void;
  placeholder: string;
  label: string;
  helpText: string;
}) {
  const updateCommand = (index: number, value: string) => {
    const updated = [...commands];
    updated[index] = value;
    onChange(updated);
  };

  const addCommand = () => {
    onChange([...commands, ""]);
  };

  const removeCommand = (index: number) => {
    onChange(commands.filter((_, i) => i !== index));
  };

  const moveCommand = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= commands.length) return;
    const updated = [...commands];
    [updated[index], updated[target]] = [updated[target]!, updated[index]!];
    onChange(updated);
  };

  return (
    // A repeated-row editor is not a row on the rail — it gets the section
    // header its caption used to be, and its rows span both columns.
    <FormSection title={label}>
      <div className="col-span-2 space-y-2">
        {commands.map((cmd, index) => (
          <div key={index} className="flex items-center gap-2">
            <span className="text-xs text-text-muted w-5 text-right font-mono select-none">
              {index + 1}.
            </span>
            <input
              type="text"
              value={cmd}
              onChange={(e) => updateCommand(index, e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              className="flex-1 px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-text-primary font-mono focus:outline-hidden focus:border-daintree-accent/40 focus:ring-1 focus:ring-daintree-accent/30"
            />
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => moveCommand(index, -1)}
                disabled={index === 0}
                className="p-0.5 rounded hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                aria-label={`Move command ${index + 1} up`}
              >
                <ChevronUp className="h-3 w-3 text-text-primary" />
              </button>
              <button
                type="button"
                onClick={() => moveCommand(index, 1)}
                disabled={index === commands.length - 1}
                className="p-0.5 rounded hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                aria-label={`Move command ${index + 1} down`}
              >
                <ChevronDown className="h-3 w-3 text-text-primary" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => removeCommand(index)}
              className="p-1 rounded hover:bg-status-error/15 transition-colors"
              aria-label={`Remove command ${index + 1}`}
            >
              <X className="h-4 w-4 text-status-error" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addCommand}
          className="flex items-center gap-1.5 text-xs text-daintree-text/60 hover:text-text-primary transition-colors px-1 py-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add command
        </button>
        <p className="text-xs text-text-muted mt-1">{helpText}</p>
      </div>
    </FormSection>
  );
}

interface IconPickerButtonProps {
  currentIcon?: string;
  onChange: (iconName: string) => void;
}

function IconPickerButton({ currentIcon, onChange }: IconPickerButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const DefaultIcon = (ICON_COMPONENTS as Record<string, any>)["Server"];
  const SelectedIcon = currentIcon ? (ICON_COMPONENTS as Record<string, any>)[currentIcon] : null;
  const DisplayIcon = SelectedIcon || DefaultIcon;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 rounded hover:bg-surface-inset border border-border-default transition-colors flex items-center justify-center"
        aria-label="Select environment icon"
      >
        <DisplayIcon className="h-4 w-4 text-text-primary" />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 p-2 bg-surface-inset border border-border-default rounded-[var(--radius-md)] shadow-lg grid grid-cols-5 gap-1 w-max">
          {ENVIRONMENT_ICON_OPTIONS.map(({ name, label }) => {
            const IconComp = (ICON_COMPONENTS as Record<string, any>)[name];
            const isSelected = currentIcon === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => {
                  onChange(name);
                  setIsOpen(false);
                }}
                className={cn(
                  "p-2 rounded flex items-center justify-center transition-colors",
                  isSelected
                    ? "bg-overlay-medium border border-border-strong"
                    : "hover:bg-surface-hover border border-transparent"
                )}
                title={label}
              >
                <IconComp className="h-4 w-4 text-text-primary" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ResourceEnvironmentsSection({
  resourceEnvironments,
  onResourceEnvironmentsChange,
  activeResourceEnvironment,
  onActiveResourceEnvironmentChange,
  defaultWorktreeMode,
  onDefaultWorktreeModeChange,
  isOpen: _isOpen,
}: EnvironmentSettingsTabProps) {
  const envKeys = useMemo(() => Object.keys(resourceEnvironments ?? {}), [resourceEnvironments]);
  const [isAddingEnvironment, setIsAddingEnvironment] = useState(false);
  const [newEnvironmentName, setNewEnvironmentName] = useState("");
  const [addEnvironmentError, setAddEnvironmentError] = useState<string | null>(null);
  const [pendingDeleteEnvironment, setPendingDeleteEnvironment] = useState<string | null>(null);

  const [selectedEnvName, setSelectedEnvName] = useState<string>(() => {
    if (activeResourceEnvironment && envKeys.includes(activeResourceEnvironment)) {
      return activeResourceEnvironment;
    }
    return envKeys[0] ?? "default";
  });

  const currentEnvName = envKeys.includes(selectedEnvName)
    ? selectedEnvName
    : (envKeys[0] ?? "default");

  useEffect(() => {
    if (activeResourceEnvironment && envKeys.includes(activeResourceEnvironment)) {
      setSelectedEnvName(activeResourceEnvironment);
      return;
    }

    if (!envKeys.includes(selectedEnvName)) {
      setSelectedEnvName(envKeys[0] ?? "default");
    }
  }, [activeResourceEnvironment, envKeys, selectedEnvName]);

  const env = useMemo(
    () => (resourceEnvironments ?? {})[currentEnvName] ?? {},
    [resourceEnvironments, currentEnvName]
  );

  const updateEnv = (patch: Partial<ResourceEnvironment>) => {
    const envs = { ...(resourceEnvironments ?? {}) };
    envs[currentEnvName] = { ...env, ...patch };
    onResourceEnvironmentsChange(envs);
  };

  const handleSelectEnv = (name: string) => {
    setSelectedEnvName(name);
    onActiveResourceEnvironmentChange(name);
  };

  const handleAddEnv = () => {
    const trimmed = newEnvironmentName.trim();
    if (!trimmed) {
      setAddEnvironmentError("Enter an environment name.");
      return;
    }
    if ((resourceEnvironments ?? {})[trimmed]) {
      setAddEnvironmentError(`Environment "${trimmed}" already exists.`);
      return;
    }
    const envs = { ...(resourceEnvironments ?? {}) };
    envs[trimmed] = {};
    onResourceEnvironmentsChange(envs);
    setSelectedEnvName(trimmed);
    onActiveResourceEnvironmentChange(trimmed);
    setIsAddingEnvironment(false);
    setNewEnvironmentName("");
    setAddEnvironmentError(null);
  };

  const handleRemoveEnv = (name: string) => {
    const envs = { ...(resourceEnvironments ?? {}) };
    delete envs[name];
    onResourceEnvironmentsChange(envs);
    const remaining = Object.keys(envs);
    if (remaining.length > 0) {
      const next = remaining[0]!;
      setSelectedEnvName(next);
      onActiveResourceEnvironmentChange(next);
    }
    setPendingDeleteEnvironment(null);
  };

  return (
    <div id="tab-nav-project:environments" className="p-1">
      <div className="flex items-center gap-2 mb-4">
        <Server className="h-5 w-5 text-daintree-text/60" />
        <h2 className="text-base font-semibold text-text-primary">Resource Environments</h2>
      </div>

      <FormGrid>
        {/* Environment selector dropdown */}
        {envKeys.length > 0 && (
          <FormRow label="Environment" selfLabelled>
            <div data-testid="environment-selector-bar" className="flex items-center gap-2">
              <select
                value={currentEnvName}
                onChange={(e) => handleSelectEnv(e.target.value)}
                aria-label="Environment"
                className={cn(FIELD_INPUT, "flex-1 min-w-0 pr-8")}
              >
                {envKeys.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <IconPickerButton currentIcon={env.icon} onChange={(icon) => updateEnv({ icon })} />
              {envKeys.length > 1 && (
                <button
                  type="button"
                  onClick={() => setPendingDeleteEnvironment(currentEnvName)}
                  className="p-1 rounded hover:bg-status-error/15 transition-colors"
                  aria-label={`Remove ${currentEnvName} environment`}
                >
                  <X className="h-4 w-4 text-status-error" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setIsAddingEnvironment(true);
                  setAddEnvironmentError(null);
                }}
                aria-label="Add environment"
                className="flex items-center gap-1 px-2 py-1.5 text-xs text-daintree-text/60 hover:text-text-primary transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </FormRow>
        )}

        {/* Empty state: no environments yet */}
        {envKeys.length === 0 && (
          <button
            type="button"
            onClick={() => {
              setIsAddingEnvironment(true);
              setAddEnvironmentError(null);
            }}
            aria-label="Add environment"
            className="col-span-2 flex w-fit items-center gap-1.5 text-xs text-daintree-text/60 hover:text-text-primary transition-colors px-1 py-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Add environment
          </button>
        )}

        {isAddingEnvironment && (
          <FormRow
            label="Environment Name"
            htmlFor="new-environment-name"
            hint={
              addEnvironmentError && (
                <p
                  id="new-environment-name-error"
                  className="text-xs text-status-error"
                  role="alert"
                >
                  {addEnvironmentError}
                </p>
              )
            }
          >
            <div data-testid="add-environment-form" className="flex items-center gap-2">
              <input
                id="new-environment-name"
                type="text"
                value={newEnvironmentName}
                onChange={(e) => {
                  setNewEnvironmentName(e.target.value);
                  setAddEnvironmentError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddEnv();
                  } else if (e.key === "Escape") {
                    setIsAddingEnvironment(false);
                    setNewEnvironmentName("");
                    setAddEnvironmentError(null);
                  }
                }}
                autoFocus
                spellCheck={false}
                placeholder="docker-local"
                aria-invalid={!!addEnvironmentError}
                aria-describedby={addEnvironmentError ? "new-environment-name-error" : undefined}
                className={cn(FIELD_INPUT, "flex-1 min-w-0 font-mono")}
              />
              <Button type="button" size="sm" onClick={handleAddEnv}>
                Add
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsAddingEnvironment(false);
                  setNewEnvironmentName("");
                  setAddEnvironmentError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </FormRow>
        )}

        {/* Variables hint */}
        <div className="col-span-2 mt-3 px-3 py-2 rounded-[var(--radius-md)] bg-surface-inset border border-border-default text-xs text-text-muted space-y-1">
          <div>
            <span className="font-medium text-daintree-text/70">Variables</span>{" "}
            <span className="text-text-secondary">(replaced at runtime in all commands):</span>
          </div>
          {/* Weight and colour rank the token above its description — an em dash
              between them read as one run of prose. Weight is also the half that
              holds under `forced-colors: active`, which repaints every author
              colour to the same system ink. The literal space inside each detail
              span stays: adjacent inline spans concatenate in the accessibility
              tree, and `ml-1` is what opens the optical gap. */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            <div>
              <code className="font-medium text-daintree-text/85">{"{branch}"}</code>
              <span className="ml-1 text-text-secondary"> branch name</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{branch-slug}"}</code>
              <span className="ml-1 text-text-secondary"> sanitized branch</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{repo-name}"}</code>
              <span className="ml-1 text-text-secondary"> repository folder</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{base-folder}"}</code>
              <span className="ml-1 text-text-secondary"> alias for repo-name</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{parent-dir}"}</code>
              <span className="ml-1 text-text-secondary"> parent directory</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{worktree_name}"}</code>
              <span className="ml-1 text-text-secondary"> worktree name</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{worktree_path}"}</code>
              <span className="ml-1 text-text-secondary"> full worktree path</span>
            </div>
            <div>
              <code className="font-medium text-daintree-text/85">{"{project_root}"}</code>
              <span className="ml-1 text-text-secondary"> project root path</span>
            </div>
          </div>
        </div>

        {envKeys.length > 0 && (
          <>
            {/* Provision Commands */}
            <CommandList
              commands={env.provision ?? []}
              onChange={(provision) => updateEnv({ provision })}
              placeholder="e.g. docker compose up -d"
              label="Provision Commands"
              helpText="Commands to run when provisioning a remote environment"
            />

            {/* Teardown Commands */}
            <CommandList
              commands={env.teardown ?? []}
              onChange={(teardown) => updateEnv({ teardown })}
              placeholder="e.g. docker compose down"
              label="Teardown Commands"
              helpText="Commands to run when destroying the environment"
            />

            {/* Resume Commands */}
            <CommandList
              commands={env.resume ?? []}
              onChange={(resume) => updateEnv({ resume })}
              placeholder="e.g. docker unpause container"
              label="Resume Commands"
              helpText="Commands to resume a paused environment without destroying"
            />

            {/* Pause Commands */}
            <CommandList
              commands={env.pause ?? []}
              onChange={(pause) => updateEnv({ pause })}
              placeholder="e.g. docker pause container"
              label="Pause Commands"
              helpText="Commands to pause the environment while preserving state"
            />

            <FormSection title="Status and connect">
              <FormRow
                label="Status Command"
                htmlFor="resource-status-command"
                hint={
                  <p id="resource-status-command-help" className="text-xs text-text-muted">
                    Must output JSON with {'{ "status": "<string>" }'}
                  </p>
                }
              >
                <input
                  id="resource-status-command"
                  type="text"
                  value={env.status ?? ""}
                  onChange={(e) => updateEnv({ status: e.target.value || undefined })}
                  placeholder="e.g. docker compose ps --format json"
                  spellCheck={false}
                  aria-describedby="resource-status-command-help"
                  className={cn(FIELD_INPUT, "font-mono")}
                />
              </FormRow>

              <FormRow
                label="Connect Command"
                htmlFor="resource-connect-command"
                hint={
                  <p id="resource-connect-command-help" className="text-xs text-text-muted">
                    Shell command for connecting (ssh, docker exec, kubectl exec)
                  </p>
                }
              >
                <input
                  id="resource-connect-command"
                  type="text"
                  value={env.connect ?? ""}
                  onChange={(e) => updateEnv({ connect: e.target.value || undefined })}
                  placeholder="e.g. docker exec -it container /bin/bash"
                  spellCheck={false}
                  aria-describedby="resource-connect-command-help"
                  className={cn(FIELD_INPUT, "font-mono")}
                />
              </FormRow>
            </FormSection>
          </>
        )}

        <FormSection title="Defaults">
          {/* No htmlFor: a set of radios has no single control to name, so the
              rail's label names the group instead. */}
          <FormRow
            label="Default worktree mode"
            labelClassName="self-start pt-2.5"
            hint={
              <p className="text-xs text-text-muted">Default mode when creating new worktrees</p>
            }
          >
            {/* No RadioChoiceGroup here: FormRow already renders the rail label
                and wires `role="group"`/`aria-labelledby` to it, so a second
                legend would name the group twice. */}
            <div className="space-y-2">
              <RadioChoiceRow
                name="worktreeMode"
                value="local"
                checked={(defaultWorktreeMode ?? "local") === "local"}
                onChange={() => onDefaultWorktreeModeChange("local")}
                label="Local"
                description="Run worktrees directly on this machine"
              />
              {envKeys.map((key) => (
                <RadioChoiceRow
                  key={key}
                  name="worktreeMode"
                  value={key}
                  checked={defaultWorktreeMode === key}
                  onChange={() => onDefaultWorktreeModeChange(key)}
                  label={key}
                  description="Run worktrees in this resource environment"
                />
              ))}
            </div>
          </FormRow>
        </FormSection>
      </FormGrid>

      <ConfirmDialog
        isOpen={pendingDeleteEnvironment !== null}
        title={`Remove '${pendingDeleteEnvironment}'?`}
        description={
          pendingDeleteEnvironment
            ? `This removes the saved commands for "${pendingDeleteEnvironment}" from project settings.`
            : undefined
        }
        confirmLabel="Remove environment"
        variant="destructive"
        onConfirm={() => {
          if (pendingDeleteEnvironment) {
            handleRemoveEnv(pendingDeleteEnvironment);
          }
        }}
        onClose={() => setPendingDeleteEnvironment(null)}
      />
    </div>
  );
}
