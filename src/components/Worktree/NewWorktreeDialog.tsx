import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  FolderOpen,
  GitBranch,
  Check,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronsUpDown,
  Search,
  UserPlus,
  Play,
  Info,
} from "lucide-react";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue } from "@shared/types/github";
import { worktreeClient, githubClient, projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { IssueSelector } from "@/components/GitHub/IssueSelector";
import { generateBranchSlug } from "@/utils/textParsing";
import { BRANCH_TYPES } from "@shared/config/branchPrefixes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toBranchOption, filterBranches, type BranchOption } from "./branchPickerUtils";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import { useNotificationStore } from "@/store/notificationStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectSettings } from "@/types";

interface NewWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rootPath: string;
  onWorktreeCreated?: () => void;
  initialIssue?: GitHubIssue | null;
}

export function NewWorktreeDialog({
  isOpen,
  onClose,
  rootPath,
  onWorktreeCreated,
  initialIssue,
}: NewWorktreeDialogProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [baseBranch, setBaseBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [fromRemote, setFromRemote] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [selectedPrefix, setSelectedPrefix] = useState(BRANCH_TYPES[0].prefix);
  const [branchExistsError, setBranchExistsError] = useState(false);
  const [branchExists, setBranchExists] = useState(false);

  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const recipeSelectionTouchedRef = useRef(false);

  const assignWorktreeToSelf = usePreferencesStore((s) => s.assignWorktreeToSelf);
  const setAssignWorktreeToSelf = usePreferencesStore((s) => s.setAssignWorktreeToSelf);
  const lastSelectedWorktreeRecipeId = usePreferencesStore((s) => s.lastSelectedWorktreeRecipeId);
  const setLastSelectedWorktreeRecipeId = usePreferencesStore(
    (s) => s.setLastSelectedWorktreeRecipeId
  );
  const githubConfig = useGitHubConfigStore((s) => s.config);
  const initializeGitHubConfig = useGitHubConfigStore((s) => s.initialize);
  const addNotification = useNotificationStore((s) => s.addNotification);
  const { recipes, runRecipe, loadRecipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);

  const currentUser = githubConfig?.username;
  const currentUserAvatar = githubConfig?.avatarUrl;
  const canAssignIssue = Boolean(currentUser && selectedIssue);

  const defaultRecipeId = projectSettings?.defaultWorktreeRecipeId;

  const globalRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);

  const selectedRecipe = selectedRecipeId
    ? globalRecipes.find((r) => r.id === selectedRecipeId)
    : undefined;

  useEffect(() => {
    initializeGitHubConfig();
  }, [initializeGitHubConfig]);

  useEffect(() => {
    if (isOpen && currentProject) {
      const requestedProjectId = currentProject.id;
      projectClient
        .getSettings(requestedProjectId)
        .then((settings) => {
          if (currentProject?.id === requestedProjectId) {
            setProjectSettings(settings);
          }
        })
        .catch((err) => console.error("Failed to load project settings:", err));

      if (recipes.length === 0) {
        loadRecipes().catch((err) => console.error("Failed to load recipes:", err));
      }
    }
  }, [isOpen, currentProject, recipes.length, loadRecipes]);

  useEffect(() => {
    if (globalRecipes.length === 0) return;
    if (recipeSelectionTouchedRef.current) return;

    // Priority: 1) Last selected recipe (including explicit "no recipe"), 2) Project default, 3) null
    // undefined = never set, null = explicit "no recipe", string = recipe ID
    if (lastSelectedWorktreeRecipeId !== undefined) {
      // User has made a previous selection (either null for "no recipe" or a recipe ID)
      if (
        lastSelectedWorktreeRecipeId === null ||
        globalRecipes.some((r) => r.id === lastSelectedWorktreeRecipeId)
      ) {
        setSelectedRecipeId(lastSelectedWorktreeRecipeId);
      } else {
        // Previously selected recipe no longer exists - clear it and fall back to default
        setLastSelectedWorktreeRecipeId(undefined);
        if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
          setSelectedRecipeId(defaultRecipeId);
        }
      }
    } else if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
      // No previous selection - use project default
      setSelectedRecipeId(defaultRecipeId);
    }
  }, [globalRecipes, lastSelectedWorktreeRecipeId, defaultRecipeId, setLastSelectedWorktreeRecipeId]);

  useEffect(() => {
    if (!selectedRecipeId) return;
    if (globalRecipes.some((recipe) => recipe.id === selectedRecipeId)) return;
    // Selected recipe no longer exists - clear both local and persisted state
    setSelectedRecipeId(null);
    setLastSelectedWorktreeRecipeId(undefined);
  }, [globalRecipes, selectedRecipeId, setLastSelectedWorktreeRecipeId]);

  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);

  const branchOptions = useMemo(() => branches.map(toBranchOption), [branches]);

  const filteredBranches = useMemo(
    () => filterBranches(branchOptions, branchQuery, 200),
    [branchOptions, branchQuery]
  );

  const selectedBranchOption = useMemo(
    () => branchOptions.find((b) => b.name === baseBranch),
    [branchOptions, baseBranch]
  );

  useEffect(() => {
    if (branchPickerOpen && branchInputRef.current) {
      requestAnimationFrame(() => {
        branchInputRef.current?.focus();
      });
    }
  }, [branchPickerOpen]);

  useEffect(() => {
    setBranchQuery("");
    setSelectedIndex(0);
  }, [branchPickerOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [branchQuery]);

  useEffect(() => {
    if (branchListRef.current && selectedIndex >= 0 && filteredBranches.length > 0) {
      const selectedItem = branchListRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, filteredBranches.length]);

  const handleBranchSelect = (option: BranchOption) => {
    setBaseBranch(option.name);
    setFromRemote(option.isRemote);
    setBranchPickerOpen(false);
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent) => {
    if (filteredBranches.length === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setBranchPickerOpen(false);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredBranches.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredBranches.length) % filteredBranches.length);
        break;
      case "Enter":
        e.preventDefault();
        if (filteredBranches[selectedIndex]) {
          handleBranchSelect(filteredBranches[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setBranchPickerOpen(false);
        break;
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setError(null);
    setBranchExistsError(false);
    setBranchExists(false);
    setBranches([]);
    setBaseBranch("");
    setFromRemote(false);
    setSelectedIssue(initialIssue ?? null);
    setNewBranch("");
    setWorktreePath("");
    setSelectedPrefix(BRANCH_TYPES[0].prefix);
    setProjectSettings(null);
    setSelectedRecipeId(null);
    recipeSelectionTouchedRef.current = false;

    let isCurrent = true;

    worktreeClient
      .listBranches(rootPath)
      .then((branchList) => {
        if (!isCurrent) return;

        setBranches(branchList);
        const currentBranch = branchList.find((b) => b.current);
        const mainBranch =
          branchList.find((b) => b.name === "main") || branchList.find((b) => b.name === "master");

        const initialBranch = mainBranch?.name || currentBranch?.name || branchList[0]?.name || "";
        setBaseBranch(initialBranch);

        // Auto-set fromRemote based on the initial branch type
        const initialBranchInfo = branchList.find((b) => b.name === initialBranch);
        setFromRemote(!!initialBranchInfo?.remote);
      })
      .catch((err) => {
        if (!isCurrent) return;
        setError(`Failed to load branches: ${err.message}`);
        setBranches([]);
        setBaseBranch("");
        setFromRemote(false);
      })
      .finally(() => {
        if (!isCurrent) return;
        setLoading(false);
      });

    return () => {
      isCurrent = false;
    };
  }, [isOpen, rootPath, initialIssue]);

  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [isOpen, loading]);

  useEffect(() => {
    if (selectedIssue) {
      const slug = generateBranchSlug(selectedIssue.title, 30);
      const suggestedBranch = slug
        ? `issue-${selectedIssue.number}-${slug}`
        : `issue-${selectedIssue.number}`;
      setNewBranch(suggestedBranch);

      const labels = selectedIssue.labels || [];
      const isBug = labels.some((l) => {
        const name = l.name.toLowerCase();
        return /\b(bug|bugfix|hotfix)\b/.test(name);
      });
      setSelectedPrefix(isBug ? "bugfix" : "feature");
    }
  }, [selectedIssue]);

  useEffect(() => {
    if (!newBranch || !rootPath) return;

    const trimmedName = newBranch.trim();
    const fullBranchName = `${selectedPrefix}/${trimmedName}`;
    const abortController = new AbortController();

    worktreeClient
      .getDefaultPath(rootPath, fullBranchName)
      .then((suggestedPath) => {
        if (!abortController.signal.aborted) {
          setWorktreePath(suggestedPath);
        }
      })
      .catch((err) => {
        if (!abortController.signal.aborted) {
          console.error("Failed to get default path:", err);
          const sanitizedBranch = fullBranchName.replace(/[^a-zA-Z0-9-_]/g, "-");
          const separator = rootPath.includes("\\") ? "\\" : "/";
          const repoName = rootPath.split(/[/\\]/).pop() || "repo";
          setWorktreePath(
            `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`
          );
        }
      });

    return () => abortController.abort();
  }, [newBranch, selectedPrefix, rootPath]);

  // Check if the branch already exists locally (debounced)
  useEffect(() => {
    if (!newBranch.trim() || branches.length === 0) {
      setBranchExists(false);
      return;
    }

    const fullBranchName = `${selectedPrefix}/${newBranch.trim()}`;
    const timeoutId = setTimeout(() => {
      // Only check for local branches - remote branches need fromRemote to be checked
      const exists = branches.some((b) => b.name === fullBranchName && !b.remote);
      setBranchExists(exists);
    }, 150);

    return () => clearTimeout(timeoutId);
  }, [newBranch, selectedPrefix, branches]);

  const handleCreate = async (useExistingBranch = false) => {
    if (!useExistingBranch && !baseBranch) {
      setError("Please select a base branch");
      return;
    }

    const trimmedName = newBranch.trim();
    if (!trimmedName) {
      setError("Please enter a branch name");
      return;
    }

    if (/[\s.]$/.test(trimmedName) || /^[.-]/.test(trimmedName)) {
      setError("Branch name cannot start with '.', '-' or end with space or '.'");
      return;
    }

    if (/[/\\:]/.test(trimmedName) || trimmedName.includes("..")) {
      setError("Branch name contains invalid characters");
      return;
    }

    if (!worktreePath.trim()) {
      setError("Please enter a worktree path");
      return;
    }

    const fullBranchName = `${selectedPrefix}/${trimmedName}`;

    setCreating(true);
    setError(null);
    setBranchExistsError(false);

    try {
      // Automatically use existing branch if we detected it exists
      const shouldUseExisting = useExistingBranch || branchExists;

      const options: CreateWorktreeOptions = {
        baseBranch,
        newBranch: fullBranchName,
        path: worktreePath.trim(),
        fromRemote,
        useExistingBranch: shouldUseExisting,
      };

      const result = await actionService.dispatch(
        "worktree.create",
        { rootPath, options },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Assign issue to current user if enabled
      if (selectedIssue && assignWorktreeToSelf && currentUser) {
        try {
          await githubClient.assignIssue(rootPath, selectedIssue.number, currentUser);
          addNotification({
            type: "success",
            title: "Issue Assigned",
            message: `Issue #${selectedIssue.number} assigned to @${currentUser}`,
          });
        } catch (assignErr) {
          const message = assignErr instanceof Error ? assignErr.message : "Failed to assign issue";
          addNotification({
            type: "warning",
            title: "Could not assign issue",
            message: `${message} — you can assign it manually on GitHub`,
          });
        }
      }

      // Run selected recipe if one is chosen
      if (selectedRecipe) {
        try {
          const worktreeId = result.result as string | undefined;
          await runRecipe(selectedRecipe.id, worktreePath.trim(), worktreeId);
        } catch (recipeErr) {
          const message = recipeErr instanceof Error ? recipeErr.message : "Failed to run recipe";
          addNotification({
            type: "warning",
            title: "Could not run recipe",
            message: `${message} — worktree was created successfully`,
          });
        }
      }

      onWorktreeCreated?.();
      onClose();

      setNewBranch("");
      setWorktreePath("");
      setFromRemote(false);
      setSelectedPrefix(BRANCH_TYPES[0].prefix);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create worktree";
      const isBranchExists = /branch named .* already exists/.test(message);
      setBranchExistsError(isBranchExists);
      setError(isBranchExists ? `Branch "${fullBranchName}" already exists` : message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" dismissible={!creating}>
      <AppDialog.Header>
        <AppDialog.Title icon={<GitBranch className="w-5 h-5 text-canopy-accent" />}>
          Create New Worktree
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-canopy-accent" />
            <span className="ml-2 text-sm text-canopy-text/60">Loading branches...</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-canopy-text">
                Link Issue (Optional)
              </label>
              <IssueSelector
                projectPath={rootPath}
                selectedIssue={selectedIssue}
                onSelect={setSelectedIssue}
                disabled={creating}
              />
              <p className="text-xs text-canopy-text/60">
                Select an issue to auto-generate a branch name
              </p>
            </div>

            {/* Assignment control - only show when issue is selected and GitHub auth available */}
            {canAssignIssue && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] border bg-canopy-bg/50 border-canopy-border transition-colors">
                {currentUserAvatar ? (
                  <img
                    src={`${currentUserAvatar}${currentUserAvatar.includes("?") ? "&" : "?"}s=64`}
                    alt={currentUser}
                    className="w-8 h-8 rounded-full shrink-0"
                  />
                ) : (
                  <div className="flex items-center justify-center w-8 h-8 rounded-full shrink-0 bg-canopy-accent/10 text-canopy-accent">
                    <UserPlus className="w-4 h-4" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-canopy-text">Assign to me</span>
                    <span className="text-xs text-canopy-text/50 font-mono">@{currentUser}</span>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={assignWorktreeToSelf}
                    onChange={(e) => setAssignWorktreeToSelf(e.target.checked)}
                    disabled={creating}
                    className="sr-only peer"
                    aria-label="Assign issue to me when creating worktree"
                  />
                  <div
                    className={cn(
                      "w-9 h-5 rounded-full transition-colors",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-canopy-accent",
                      "after:content-[''] after:absolute after:top-0.5 after:left-0.5",
                      "after:bg-white after:rounded-full after:h-4 after:w-4",
                      "after:transition-transform after:duration-200",
                      assignWorktreeToSelf
                        ? "bg-canopy-accent after:translate-x-4"
                        : "bg-canopy-border after:translate-x-0",
                      creating && "opacity-50 cursor-not-allowed"
                    )}
                  />
                </label>
              </div>
            )}

            <div className="space-y-2">
              <label htmlFor="base-branch" className="block text-sm font-medium text-canopy-text">
                Base Branch
              </label>
              <Popover open={branchPickerOpen} onOpenChange={setBranchPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="base-branch"
                    variant="outline"
                    role="combobox"
                    aria-expanded={branchPickerOpen}
                    aria-haspopup="listbox"
                    className="w-full justify-between bg-canopy-bg border-canopy-border text-canopy-text hover:bg-canopy-bg hover:text-canopy-text"
                    disabled={creating}
                  >
                    <span className="truncate">
                      {selectedBranchOption?.labelText || "Select base branch..."}
                    </span>
                    <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <div className="flex items-center border-b border-canopy-border px-3">
                    <Search className="mr-2 h-4 w-4 opacity-50 shrink-0" />
                    <input
                      ref={branchInputRef}
                      className="flex h-10 w-full rounded-[var(--radius-md)] bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder="Search branches..."
                      value={branchQuery}
                      onChange={(e) => setBranchQuery(e.target.value)}
                      onKeyDown={handleBranchKeyDown}
                      role="combobox"
                      aria-label="Search base branches"
                      aria-autocomplete="list"
                      aria-controls="branch-list"
                      aria-expanded={branchPickerOpen}
                      aria-activedescendant={
                        filteredBranches.length > 0 && selectedIndex >= 0
                          ? `branch-option-${selectedIndex}`
                          : undefined
                      }
                    />
                  </div>
                  <div
                    ref={branchListRef}
                    id="branch-list"
                    role="listbox"
                    className="max-h-[300px] overflow-y-auto p-1"
                  >
                    {filteredBranches.length === 0 ? (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        {branchQuery ? "No branches found" : "No branches available"}
                      </div>
                    ) : (
                      filteredBranches.map((option, index) => (
                        <div
                          key={option.name}
                          id={`branch-option-${index}`}
                          role="option"
                          aria-selected={option.name === baseBranch}
                          onClick={() => handleBranchSelect(option)}
                          className={cn(
                            "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                            option.name === baseBranch && "bg-canopy-border",
                            index === selectedIndex && "bg-canopy-accent/10"
                          )}
                        >
                          <span className="truncate">{option.labelText}</span>
                          {option.name === baseBranch && (
                            <Check className="h-4 w-4 shrink-0 text-canopy-accent" />
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  {!branchQuery && filteredBranches.length >= 200 && (
                    <div className="border-t border-canopy-border px-3 py-2 text-xs text-canopy-text/60">
                      Showing first 200 branches. Type to narrow results.
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <p className="text-xs text-canopy-text/60">
                The branch to create the new worktree from
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="new-branch" className="block text-sm font-medium text-canopy-text">
                New Branch Name
              </label>
              <div className="flex gap-2 items-center">
                <div className="relative shrink-0">
                  <select
                    value={selectedPrefix}
                    onChange={(e) => setSelectedPrefix(e.target.value)}
                    className="appearance-none h-full px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text text-sm focus:outline-none focus:ring-2 focus:ring-canopy-accent pr-8"
                    disabled={creating}
                  >
                    {BRANCH_TYPES.map((type) => (
                      <option key={type.id} value={type.prefix}>
                        {type.displayName}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-canopy-text/40">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>

                <span className="text-canopy-text/40 font-mono">/</span>

                <input
                  ref={newBranchInputRef}
                  id="new-branch"
                  type="text"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="my-awesome-feature"
                  className="flex-1 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
                  disabled={creating}
                  aria-describedby={branchExists ? "branch-exists-hint" : undefined}
                />
              </div>
              <p className="text-xs text-canopy-text/60">
                Full branch:{" "}
                <span className="font-mono text-canopy-accent">
                  {selectedPrefix}/{newBranch || "..."}
                </span>
              </p>
              {branchExists && (
                <p
                  id="branch-exists-hint"
                  className="text-xs text-canopy-accent flex items-center gap-1.5 mt-1"
                  role="status"
                  aria-live="polite"
                >
                  <Info className="w-3.5 h-3.5" aria-hidden="true" />
                  This branch already exists and will be reused
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="worktree-path" className="block text-sm font-medium text-canopy-text">
                Worktree Path
              </label>
              <div className="flex gap-2 items-center">
                <input
                  id="worktree-path"
                  type="text"
                  value={worktreePath}
                  onChange={(e) => setWorktreePath(e.target.value)}
                  placeholder="/path/to/worktree"
                  className="flex-1 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
                  disabled={creating}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      const result = await actionService.dispatch("project.openDialog", undefined, {
                        source: "user",
                      });
                      if (result.ok && result.result) {
                        setWorktreePath(result.result as string);
                        setError(null);
                      }
                    } catch (err: unknown) {
                      console.error("Failed to open directory picker:", err);
                      const message = err instanceof Error ? err.message : "Unknown error";
                      setError(`Failed to open directory picker: ${message}`);
                    }
                  }}
                  disabled={creating}
                >
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-canopy-text/60">
                Directory where the worktree will be created
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="from-remote"
                type="checkbox"
                checked={fromRemote}
                onChange={(e) => setFromRemote(e.target.checked)}
                className="rounded border-canopy-border text-canopy-accent focus:ring-canopy-accent"
                disabled={creating}
              />
              <label htmlFor="from-remote" className="text-sm text-canopy-text select-none">
                Create from remote branch
              </label>
            </div>

            {globalRecipes.length > 0 && (
              <div className="space-y-2">
                <label
                  htmlFor="recipe-selector"
                  className="block text-sm font-medium text-canopy-text"
                >
                  Run Recipe (Optional)
                </label>
                <Popover open={recipePickerOpen} onOpenChange={setRecipePickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="recipe-selector"
                      variant="outline"
                      role="combobox"
                      aria-expanded={recipePickerOpen}
                      aria-haspopup="listbox"
                      aria-controls="recipe-list"
                      className="w-full justify-between bg-canopy-bg border-canopy-border text-canopy-text hover:bg-canopy-bg hover:text-canopy-text"
                      disabled={creating}
                    >
                      <span className="flex items-center gap-2 truncate">
                        <Play className="w-4 h-4 shrink-0 text-canopy-accent" />
                        {selectedRecipe ? (
                          <>
                            <span>{selectedRecipe.name}</span>
                            <span className="text-xs text-canopy-text/50">
                              ({selectedRecipe.terminals.length} terminal
                              {selectedRecipe.terminals.length !== 1 ? "s" : ""})
                            </span>
                          </>
                        ) : (
                          <span className="text-canopy-text/60">No recipe</span>
                        )}
                      </span>
                      <ChevronsUpDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0" align="start">
                    <div
                      id="recipe-list"
                      role="listbox"
                      className="max-h-[300px] overflow-y-auto p-1"
                    >
                      <div
                        role="option"
                        aria-selected={selectedRecipeId === null}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            recipeSelectionTouchedRef.current = true;
                            setSelectedRecipeId(null);
                            setLastSelectedWorktreeRecipeId(null);
                            setRecipePickerOpen(false);
                          }
                        }}
                        onClick={() => {
                          recipeSelectionTouchedRef.current = true;
                          setSelectedRecipeId(null);
                          setLastSelectedWorktreeRecipeId(null);
                          setRecipePickerOpen(false);
                        }}
                        className={cn(
                          "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                          selectedRecipeId === null && "bg-canopy-border"
                        )}
                      >
                        <span className="text-canopy-text/60">No recipe</span>
                        {selectedRecipeId === null && (
                          <Check className="h-4 w-4 shrink-0 text-canopy-accent" />
                        )}
                      </div>
                      {globalRecipes.map((recipe) => (
                        <div
                          key={recipe.id}
                          role="option"
                          aria-selected={recipe.id === selectedRecipeId}
                          tabIndex={0}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              recipeSelectionTouchedRef.current = true;
                              setSelectedRecipeId(recipe.id);
                              setLastSelectedWorktreeRecipeId(recipe.id);
                              setRecipePickerOpen(false);
                            }
                          }}
                          onClick={() => {
                            recipeSelectionTouchedRef.current = true;
                            setSelectedRecipeId(recipe.id);
                            setLastSelectedWorktreeRecipeId(recipe.id);
                            setRecipePickerOpen(false);
                          }}
                          className={cn(
                            "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                            recipe.id === selectedRecipeId && "bg-canopy-border"
                          )}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate">{recipe.name}</span>
                            <span className="text-xs text-canopy-text/50 shrink-0">
                              {recipe.terminals.length} terminal
                              {recipe.terminals.length !== 1 ? "s" : ""}
                            </span>
                            {recipe.id === defaultRecipeId && (
                              <span className="text-xs text-canopy-accent shrink-0">(default)</span>
                            )}
                          </div>
                          {recipe.id === selectedRecipeId && (
                            <Check className="h-4 w-4 shrink-0 text-canopy-accent" />
                          )}
                        </div>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-canopy-text/60">
                  Select a recipe to run after creating the worktree
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[var(--radius-md)]">
                <AlertCircle className="w-4 h-4 text-[var(--color-status-error)] mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm text-[var(--color-status-error)]">{error}</p>
                  {branchExistsError && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => handleCreate(true)}
                      disabled={creating}
                    >
                      <GitBranch className="w-3.5 h-3.5 mr-1.5" />
                      Use existing branch
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button
          onClick={() => handleCreate()}
          disabled={creating || loading}
          className="min-w-[100px]"
        >
          {creating ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Check className="w-4 h-4 mr-2" />
              Create
            </>
          )}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
