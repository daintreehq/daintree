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
import { FIELD_INPUT } from "@/components/Worktree/views";
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Input } from "@/components/ui/input";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";

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

const RESOURCE_VARIABLES = [
  ["{branch}", "branch name"],
  ["{branch-slug}", "sanitized branch"],
  ["{repo-name}", "repository folder"],
  ["{base-folder}", "alias for repo-name"],
  ["{parent-dir}", "parent directory"],
  ["{worktree_name}", "worktree name"],
  ["{worktree_path}", "full worktree path"],
  ["{project_root}", "project root path"],
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
    // A repeated-row editor is a stacked row: the list is the control.
    <SettingsRow
      label={label}
      description={helpText}
      layout="stacked"
      control={({ labelId }) => (
        <div className="space-y-2" role="group" aria-labelledby={labelId}>
          {commands.map((cmd, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="text-xs text-text-secondary w-5 text-right font-mono select-none">
                {index + 1}.
              </span>
              <Input
                type="text"
                value={cmd}
                onChange={(e) => updateCommand(index, e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                aria-label={`${label} ${index + 1}`}
                className="flex-1 min-w-0 font-mono"
              />
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => moveCommand(index, -1)}
                  disabled={index === 0}
                  className="p-0.5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                  aria-label={`Move command ${index + 1} up`}
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveCommand(index, 1)}
                  disabled={index === commands.length - 1}
                  className="p-0.5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                  aria-label={`Move command ${index + 1} down`}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => removeCommand(index)}
                className="p-1 rounded-[var(--radius-sm)] text-text-secondary hover:text-status-error hover:bg-overlay-soft transition-colors"
                aria-label={`Remove command ${index + 1}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button type="button" variant="outline" size="xs" onClick={addCommand}>
            <Plus />
            Add command
          </Button>
        </div>
      )}
    />
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
        className="h-8 w-8 rounded-[var(--radius-md)] hover:bg-overlay-soft border border-border-default transition-colors flex items-center justify-center"
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
                  "p-2 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors",
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

  const openAddForm = () => {
    setIsAddingEnvironment(true);
    setAddEnvironmentError(null);
  };

  const cancelAddForm = () => {
    setIsAddingEnvironment(false);
    setNewEnvironmentName("");
    setAddEnvironmentError(null);
  };

  return (
    <SettingsSection
      id="tab-nav-project:environments"
      title="Resource environments"
      description="Run worktrees somewhere other than this machine — a container, a VM, a remote host"
      action={
        envKeys.length > 0 && !isAddingEnvironment ? (
          <Button type="button" variant="outline" size="sm" onClick={openAddForm}>
            <Plus />
            Add environment
          </Button>
        ) : undefined
      }
    >
      {(envKeys.length > 0 || isAddingEnvironment) && (
        <SettingsGroup>
          {envKeys.length > 0 && (
            <SettingsRow
              label="Environment"
              description="The environment the commands below belong to"
              control={({ labelId, descriptionId }) => (
                <div data-testid="environment-selector-bar" className="flex items-center gap-2">
                  <select
                    value={currentEnvName}
                    onChange={(e) => handleSelectEnv(e.target.value)}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    className={cn(FIELD_INPUT, "w-52 min-w-0 pr-8")}
                  >
                    {envKeys.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <IconPickerButton
                    currentIcon={env.icon}
                    onChange={(icon) => updateEnv({ icon })}
                  />
                  {envKeys.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPendingDeleteEnvironment(currentEnvName)}
                      className="p-1 rounded-[var(--radius-sm)] text-text-secondary hover:text-status-error hover:bg-overlay-soft transition-colors"
                      aria-label={`Remove ${currentEnvName} environment`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
            />
          )}

          {isAddingEnvironment && (
            <SettingsRow
              label="New environment name"
              layout="stacked"
              control={({ labelId }) => (
                <div className="space-y-1.5">
                  <div data-testid="add-environment-form" className="flex items-center gap-2">
                    <Input
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
                          cancelAddForm();
                        }
                      }}
                      autoFocus
                      spellCheck={false}
                      placeholder="docker-local"
                      aria-labelledby={labelId}
                      invalid={!!addEnvironmentError}
                      aria-invalid={!!addEnvironmentError}
                      aria-describedby={
                        addEnvironmentError ? "new-environment-name-error" : undefined
                      }
                      className="flex-1 min-w-0 font-mono"
                    />
                    <Button type="button" variant="contrast" size="sm" onClick={handleAddEnv}>
                      Add
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={cancelAddForm}>
                      Cancel
                    </Button>
                  </div>
                  {addEnvironmentError && (
                    <p
                      id="new-environment-name-error"
                      className="text-xs text-status-error"
                      role="alert"
                    >
                      {addEnvironmentError}
                    </p>
                  )}
                </div>
              )}
            />
          )}
        </SettingsGroup>
      )}

      {envKeys.length === 0 && !isAddingEnvironment && (
        <SettingsGroup>
          <SettingsRow
            label="No environments yet"
            description="Add one to provision worktrees in a container, VM, or remote host"
            control={
              <Button type="button" variant="outline" size="sm" onClick={openAddForm}>
                <Plus />
                Add environment
              </Button>
            }
          />
        </SettingsGroup>
      )}

      {envKeys.length > 0 && (
        <>
          <SettingsGroup label="Lifecycle commands">
            <CommandList
              commands={env.provision ?? []}
              onChange={(provision) => updateEnv({ provision })}
              placeholder="e.g. docker compose up -d"
              label="Provision commands"
              helpText="Commands to run when provisioning a remote environment"
            />
            <CommandList
              commands={env.teardown ?? []}
              onChange={(teardown) => updateEnv({ teardown })}
              placeholder="e.g. docker compose down"
              label="Teardown commands"
              helpText="Commands to run when destroying the environment"
            />
            <CommandList
              commands={env.resume ?? []}
              onChange={(resume) => updateEnv({ resume })}
              placeholder="e.g. docker unpause container"
              label="Resume commands"
              helpText="Commands to resume a paused environment without destroying"
            />
            <CommandList
              commands={env.pause ?? []}
              onChange={(pause) => updateEnv({ pause })}
              placeholder="e.g. docker pause container"
              label="Pause commands"
              helpText="Commands to pause the environment while preserving state"
            />
          </SettingsGroup>

          <SettingsGroup label="Status and connect">
            <SettingsInput
              label="Status command"
              description={<>Must output JSON with {'{ "status": "<string>" }'}</>}
              value={env.status ?? ""}
              onChange={(e) => updateEnv({ status: e.target.value || undefined })}
              placeholder="e.g. docker compose ps --format json"
              spellCheck={false}
              className="font-mono"
            />
            <SettingsInput
              label="Connect command"
              description="Shell command for connecting (ssh, docker exec, kubectl exec)"
              value={env.connect ?? ""}
              onChange={(e) => updateEnv({ connect: e.target.value || undefined })}
              placeholder="e.g. docker exec -it container /bin/bash"
              spellCheck={false}
              className="font-mono"
            />
          </SettingsGroup>

          <SettingsGroup>
            <SettingsRow
              label="Variables"
              description="Replaced at runtime in all commands"
              layout="stacked"
              control={
                // Weight and colour rank the token above its description — an em dash
                // between them read as one run of prose. Weight is also the half that
                // holds under `forced-colors: active`, which repaints every author
                // colour to the same system ink. The literal space inside each detail
                // span stays: adjacent inline spans concatenate in the accessibility
                // tree, and `ml-1` is what opens the optical gap.
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                  {RESOURCE_VARIABLES.map(([token, detail]) => (
                    <div key={token}>
                      <code className="font-medium text-text-primary">{token}</code>
                      <span className="ml-1 text-text-secondary"> {detail}</span>
                    </div>
                  ))}
                </div>
              }
            />
          </SettingsGroup>
        </>
      )}

      <SettingsGroup className="checkbox-neutral">
        <SettingsRow
          label="Default worktree mode"
          description="Default mode when creating new worktrees"
          layout="stacked"
          control={({ labelId }) => (
            <div role="radiogroup" aria-labelledby={labelId} className="-mx-3 -my-1">
              <RadioChoiceRow
                name="worktreeMode"
                value="local"
                checked={(defaultWorktreeMode ?? "local") === "local"}
                onChange={() => onDefaultWorktreeModeChange("local")}
                label="Local"
                description="Run worktrees directly on this machine"
                bare
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
                  bare
                />
              ))}
            </div>
          )}
        />
      </SettingsGroup>

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
    </SettingsSection>
  );
}
