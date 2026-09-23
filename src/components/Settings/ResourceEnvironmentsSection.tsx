import { useState, useMemo, useEffect, useRef } from "react";
import {
  Plus,
  Trash2,
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
import { RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSection } from "./SettingsSection";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsListRow } from "./SettingsListEditor";

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

const ICON_COMPONENTS: Record<(typeof ENVIRONMENT_ICON_OPTIONS)[number]["name"], typeof Server> = {
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

interface IconPickerButtonProps {
  currentIcon?: string;
  onChange: (iconName: string) => void;
}

function IconPickerButton({ currentIcon, onChange }: IconPickerButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const current = ENVIRONMENT_ICON_OPTIONS.find((o) => o.name === currentIcon);
  const DisplayIcon = ICON_COMPONENTS[current?.name ?? "Server"];

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={`Environment icon: ${current?.label ?? "Server"}`}
        >
          <DisplayIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <div role="group" aria-label="Environment icon" className="grid grid-cols-5 gap-1">
          {ENVIRONMENT_ICON_OPTIONS.map(({ name, label }) => {
            const IconComp = ICON_COMPONENTS[name];
            const isSelected = (currentIcon ?? "Server") === name;
            return (
              <Button
                key={name}
                type="button"
                variant="ghost"
                size="icon"
                aria-pressed={isSelected}
                aria-label={label}
                title={label}
                onClick={() => {
                  onChange(name);
                  setIsOpen(false);
                }}
                className={cn(isSelected && "bg-overlay-selected text-text-primary")}
              >
                <IconComp />
              </Button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
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
  // The inline add form unmounts the focused field when it closes, so say where
  // focus goes: the selector showing the new environment, or back to Add.
  const [returnFocus, setReturnFocus] = useState<"selector" | "add" | null>(null);
  const selectorRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!returnFocus) return;
    (returnFocus === "selector" ? selectorRef : addButtonRef).current?.focus();
    setReturnFocus(null);
  }, [returnFocus]);

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
      setAddEnvironmentError("Enter a name for the environment");
      return;
    }
    if ((resourceEnvironments ?? {})[trimmed]) {
      setAddEnvironmentError(`An environment named "${trimmed}" already exists`);
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
    setReturnFocus("selector");
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
    setReturnFocus("add");
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openAddForm}
            ref={addButtonRef}
          >
            <Plus />
            Add environment
          </Button>
        ) : undefined
      }
    >
      <SettingsGroup>
        {envKeys.length === 0 && !isAddingEnvironment && (
          <SettingsEmptyRow
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openAddForm}
                ref={addButtonRef}
              >
                <Plus />
                Add environment
              </Button>
            }
          >
            Add an environment to run worktrees off this machine
          </SettingsEmptyRow>
        )}

        {envKeys.length > 0 && (
          <SettingsRow
            label="Environment"
            description="The environment the commands below belong to"
            control={({ labelId, descriptionId }) => (
              <div data-testid="environment-selector-bar" className="flex items-center gap-2">
                <Select value={currentEnvName} onValueChange={handleSelectEnv}>
                  <SelectTrigger
                    ref={selectorRef}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    className={cn(SETTINGS_CONTROL_WIDTH.select, "font-mono")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {envKeys.map((name) => (
                      <SelectItem key={name} value={name} className="font-mono">
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <IconPickerButton currentIcon={env.icon} onChange={(icon) => updateEnv({ icon })} />
                {envKeys.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost-danger"
                    size="icon-sm"
                    onClick={() => setPendingDeleteEnvironment(currentEnvName)}
                    aria-label={`Delete ${currentEnvName} environment`}
                  >
                    <Trash2 />
                  </Button>
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
                    className={cn(SETTINGS_CONTROL_WIDTH.wide, "font-mono")}
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

      {envKeys.length > 0 && (
        <>
          <SettingsGroup label="Lifecycle commands">
            <SettingsListRow
              items={env.provision ?? []}
              onChange={(provision) => updateEnv({ provision })}
              placeholder="e.g. docker compose up -d"
              label="Provision commands"
              description="Commands to run when provisioning a remote environment"
              itemNoun="Provision command"
              addLabel="Add command"
              reorderable
            />
            <SettingsListRow
              items={env.teardown ?? []}
              onChange={(teardown) => updateEnv({ teardown })}
              placeholder="e.g. docker compose down"
              label="Teardown commands"
              description="Commands to run when destroying the environment"
              itemNoun="Teardown command"
              addLabel="Add command"
              reorderable
            />
            <SettingsListRow
              items={env.resume ?? []}
              onChange={(resume) => updateEnv({ resume })}
              placeholder="e.g. docker unpause container"
              label="Resume commands"
              description="Commands to resume a paused environment without destroying"
              itemNoun="Resume command"
              addLabel="Add command"
              reorderable
            />
            <SettingsListRow
              items={env.pause ?? []}
              onChange={(pause) => updateEnv({ pause })}
              placeholder="e.g. docker pause container"
              label="Pause commands"
              description="Commands to pause the environment while preserving state"
              itemNoun="Pause command"
              addLabel="Add command"
              reorderable
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

      {envKeys.length > 0 && (
        <SettingsGroup className="checkbox-neutral">
          <SettingsRow
            label="Default worktree mode"
            description="Where new worktrees run unless you choose otherwise when creating one"
            layout="stacked"
            control={({ labelId }) => (
              <div
                role="radiogroup"
                aria-labelledby={labelId}
                className="-mx-4 -mb-3 border-t border-border-subtle divide-y divide-border-subtle"
              >
                <RadioChoiceRow
                  name="worktreeMode"
                  value="local"
                  checked={(defaultWorktreeMode ?? "local") === "local"}
                  onChange={() => onDefaultWorktreeModeChange("local")}
                  label="Local"
                  description="Run worktrees directly on this machine"
                  bare
                  className="w-full px-4 py-3"
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
                    className="w-full px-4 py-3"
                  />
                ))}
              </div>
            )}
          />
        </SettingsGroup>
      )}

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
