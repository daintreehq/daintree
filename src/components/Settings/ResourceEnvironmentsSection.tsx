import { useState, useCallback, useMemo, useEffect } from "react";
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
    [updated[index], updated[target]] = [updated[target], updated[index]];
    onChange(updated);
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-text-primary mb-2">{label}</h3>
      <div className="space-y-2">
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
              className="flex-1 px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
            />
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => moveCommand(index, -1)}
                disabled={index === 0}
                className="p-0.5 rounded hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label={`Move command ${index + 1} up`}
              >
                <ChevronUp className="h-3 w-3 text-canopy-text" />
              </button>
              <button
                type="button"
                onClick={() => moveCommand(index, 1)}
                disabled={index === commands.length - 1}
                className="p-0.5 rounded hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label={`Move command ${index + 1} down`}
              >
                <ChevronDown className="h-3 w-3 text-canopy-text" />
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
          className="flex items-center gap-1.5 text-xs text-canopy-text/60 hover:text-canopy-text transition-colors px-1 py-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add command
        </button>
      </div>
      <p className="text-xs text-text-muted mt-1">{helpText}</p>
    </div>
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
        <DisplayIcon className="h-4 w-4 text-canopy-text" />
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
                    ? "bg-canopy-accent/20 border border-canopy-accent"
                    : "hover:bg-surface-hover border border-transparent"
                )}
                title={label}
              >
                <IconComp className="h-4 w-4 text-canopy-text" />
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

  const updateEnv = useCallback(
    (patch: Partial<ResourceEnvironment>) => {
      const envs = { ...(resourceEnvironments ?? {}) };
      envs[currentEnvName] = { ...env, ...patch };
      onResourceEnvironmentsChange(envs);
    },
    [env, currentEnvName, resourceEnvironments, onResourceEnvironmentsChange]
  );

  const handleSelectEnv = (name: string) => {
    setSelectedEnvName(name);
    onActiveResourceEnvironmentChange(name);
  };

  const handleAddEnv = useCallback(() => {
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
  }, [
    newEnvironmentName,
    onActiveResourceEnvironmentChange,
    onResourceEnvironmentsChange,
    resourceEnvironments,
  ]);

  const handleRemoveEnv = useCallback(
    (name: string) => {
      const envs = { ...(resourceEnvironments ?? {}) };
      delete envs[name];
      onResourceEnvironmentsChange(envs);
      const remaining = Object.keys(envs);
      if (remaining.length > 0) {
        const next = remaining[0];
        setSelectedEnvName(next);
        onActiveResourceEnvironmentChange(next);
      }
      setPendingDeleteEnvironment(null);
    },
    [
      envKeys.length,
      onActiveResourceEnvironmentChange,
      onResourceEnvironmentsChange,
      resourceEnvironments,
    ]
  );

  return (
    <div className="space-y-6 p-1">
      <div className="flex items-center gap-2 mb-2">
        <Server className="h-5 w-5 text-canopy-text/60" />
        <h2 className="text-base font-semibold text-text-primary">Resource Environments</h2>
      </div>

      {/* Environment selector dropdown */}
      {envKeys.length > 0 && (
        <div data-testid="environment-selector-bar" className="flex items-center gap-2">
          <select
            value={currentEnvName}
            onChange={(e) => handleSelectEnv(e.target.value)}
            aria-label="Select environment"
            className="flex-1 px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
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
              className="p-1.5 rounded hover:bg-status-error/15 transition-colors"
              aria-label={`Remove ${currentEnvName} environment`}
            >
              <X className="h-4 w-4 text-status-error/60" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setIsAddingEnvironment(true);
              setAddEnvironmentError(null);
            }}
            aria-label="Add environment"
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-canopy-text/60 hover:text-canopy-text transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
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
          className="flex items-center gap-1.5 text-xs text-canopy-text/60 hover:text-canopy-text transition-colors px-1 py-1"
        >
          <Plus className="h-3.5 w-3.5" />
          Add environment
        </button>
      )}

      {isAddingEnvironment && (
        <div
          data-testid="add-environment-form"
          className="space-y-2 p-3 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg"
        >
          <label
            className="block text-sm font-medium text-text-primary"
            htmlFor="new-environment-name"
          >
            Environment Name
          </label>
          <div className="flex items-center gap-2">
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
              className="flex-1 px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
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
          {addEnvironmentError && (
            <p className="text-xs text-status-error">{addEnvironmentError}</p>
          )}
        </div>
      )}

      {/* Variables hint */}
      <div className="px-3 py-2 rounded-[var(--radius-md)] bg-surface-inset border border-border-default text-xs text-text-muted space-y-1">
        <div>
          <span className="font-medium text-canopy-text/70">Variables</span>{" "}
          <span className="text-canopy-text/40">(replaced at runtime in all commands):</span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <div>
            <code className="text-canopy-accent/80">{"{branch}"}</code>
            <span className="text-canopy-text/40"> — branch name</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{branch-slug}"}</code>
            <span className="text-canopy-text/40"> — sanitized branch</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{repo-name}"}</code>
            <span className="text-canopy-text/40"> — repository folder</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{base-folder}"}</code>
            <span className="text-canopy-text/40"> — alias for repo-name</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{parent-dir}"}</code>
            <span className="text-canopy-text/40"> — parent directory</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{worktree_name}"}</code>
            <span className="text-canopy-text/40"> — worktree name</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{worktree_path}"}</code>
            <span className="text-canopy-text/40"> — full worktree path</span>
          </div>
          <div>
            <code className="text-canopy-accent/80">{"{project_root}"}</code>
            <span className="text-canopy-text/40"> — project root path</span>
          </div>
        </div>
      </div>

      {envKeys.length > 0 && (
        <>
          {/* Provision Commands */}
          <CommandList
            commands={env.provision ?? []}
            onChange={(provision) => updateEnv({ provision })}
            placeholder="docker compose -p {worktree_name} up -d"
            label="Provision Commands"
            helpText="Commands to run when provisioning a remote environment"
          />

          {/* Teardown Commands */}
          <CommandList
            commands={env.teardown ?? []}
            onChange={(teardown) => updateEnv({ teardown })}
            placeholder="docker compose -p {worktree_name} down -v"
            label="Teardown Commands"
            helpText="Commands to run when destroying the environment"
          />

          {/* Resume Commands */}
          <CommandList
            commands={env.resume ?? []}
            onChange={(resume) => updateEnv({ resume })}
            placeholder="docker compose -p {worktree_name} start"
            label="Resume Commands"
            helpText="Commands to resume a paused environment without destroying"
          />

          {/* Pause Commands */}
          <CommandList
            commands={env.pause ?? []}
            onChange={(pause) => updateEnv({ pause })}
            placeholder="docker compose -p {worktree_name} stop"
            label="Pause Commands"
            helpText="Commands to pause the environment while preserving state"
          />

          {/* Status Command */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">Status Command</h3>
            <input
              type="text"
              value={env.status ?? ""}
              onChange={(e) => updateEnv({ status: e.target.value || undefined })}
              placeholder={"docker compose -p {worktree_name} ps --format json"}
              spellCheck={false}
              className="w-full px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
            />
            <p className="text-xs text-text-muted mt-1">
              Must output JSON with {'{ "status": "<string>" }'}
            </p>
          </div>

          {/* Connect Command */}
          <div>
            <h3 className="text-sm font-medium text-text-primary mb-2">Connect Command</h3>
            <input
              type="text"
              value={env.connect ?? ""}
              onChange={(e) => updateEnv({ connect: e.target.value || undefined })}
              placeholder="docker compose -p {worktree_name} exec app bash"
              spellCheck={false}
              className="w-full px-3 py-1.5 text-sm bg-surface-inset border border-border-default rounded-[var(--radius-md)] text-canopy-text font-mono focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent/30"
            />
            <p className="text-xs text-text-muted mt-1">
              Shell command for connecting (ssh, docker exec, kubectl exec)
            </p>
          </div>
        </>
      )}

      {/* Default Worktree Mode */}
      <div>
        <h3 className="text-sm font-medium text-text-primary mb-2">Default Worktree Mode</h3>
        <div className="flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="worktreeMode"
              value="local"
              checked={(defaultWorktreeMode ?? "local") === "local"}
              onChange={() => onDefaultWorktreeModeChange("local")}
              className="accent-canopy-accent"
            />
            <span className="text-sm text-canopy-text">Local</span>
          </label>
          {envKeys.map((key) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                name="worktreeMode"
                value={key}
                checked={defaultWorktreeMode === key}
                onChange={() => onDefaultWorktreeModeChange(key)}
                className="accent-canopy-accent"
              />
              <span className="text-sm text-canopy-text">{key}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-1">Default mode when creating new worktrees</p>
      </div>

      <ConfirmDialog
        isOpen={pendingDeleteEnvironment !== null}
        title="Remove environment?"
        description={
          pendingDeleteEnvironment
            ? `Remove environment "${pendingDeleteEnvironment}"? This only removes its saved commands from project settings.`
            : undefined
        }
        confirmLabel="Remove"
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
