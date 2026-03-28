import { useState, useEffect, useRef, useMemo, useCallback, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  FolderOpen,
  Check,
  AlertCircle,
  ChevronsUpDown,
  Search,
  UserPlus,
  Play,
  Info,
  ChevronDown,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { WorktreeIcon } from "@/components/icons";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { worktreeClient, githubClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { IssueSelector } from "@/components/GitHub/IssueSelector";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseBranchInput } from "./branchPrefixUtils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import { notify } from "@/lib/notify";
import { systemClient } from "@/clients/systemClient";
import { useRecipeStore } from "@/store/recipeStore";
import { mapCreationError, type WorktreeCreationError } from "./worktreeCreationErrors";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

import { useNewWorktreeProjectSettings } from "./hooks/useNewWorktreeProjectSettings";
import { useBranchInput } from "./hooks/useBranchInput";
import { useBranchValidation } from "./hooks/useBranchValidation";
import { useBranchPicker } from "./hooks/useBranchPicker";
import { usePrefixPicker } from "./hooks/usePrefixPicker";
import { useRecipePicker } from "./hooks/useRecipePicker";

function HighlightBranchText({
  text,
  matchRanges,
  nameLength,
}: {
  text: string;
  matchRanges: { start: number; end: number }[];
  nameLength: number;
}) {
  if (matchRanges.length === 0) return <>{text}</>;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;

  for (let i = 0; i < matchRanges.length; i++) {
    const { start, end } = matchRanges[i];
    if (start >= nameLength) break;
    const clampedEnd = Math.min(end, nameLength - 1);
    if (start > lastIndex) {
      nodes.push(text.substring(lastIndex, start));
    }
    nodes.push(
      <mark key={i} className="bg-canopy-accent/25 text-inherit rounded-sm">
        {text.substring(start, clampedEnd + 1)}
      </mark>
    );
    lastIndex = clampedEnd + 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.substring(lastIndex));
  }

  return <>{nodes}</>;
}

interface NewWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rootPath: string;
  onWorktreeCreated?: () => void;
  initialIssue?: GitHubIssue | null;
  initialPR?: GitHubPR | null;
  initialRecipeId?: string | null;
}

export function NewWorktreeDialog({
  isOpen,
  onClose,
  rootPath,
  onWorktreeCreated,
  initialIssue,
  initialPR,
  initialRecipeId,
}: NewWorktreeDialogProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<WorktreeCreationError | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [prBranchResolved, setPrBranchResolved] = useState<boolean | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);

  const assignWorktreeToSelf = usePreferencesStore((s) => s.assignWorktreeToSelf);
  const setAssignWorktreeToSelf = usePreferencesStore((s) => s.setAssignWorktreeToSelf);
  const lastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.lastSelectedWorktreeRecipeIdByProject
  );
  const setLastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.setLastSelectedWorktreeRecipeIdByProject
  );
  const githubConfig = useGitHubConfigStore((s) => s.config);
  const initializeGitHubConfig = useGitHubConfigStore((s) => s.initialize);
  const refreshGitHubConfig = useGitHubConfigStore((s) => s.refresh);
  const { recipes, runRecipe } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];

  const currentUser = githubConfig?.username;
  const currentUserAvatar = githubConfig?.avatarUrl;

  // --- Hook: Project Settings ---
  const { projectSettings, configuredBranchPrefix } = useNewWorktreeProjectSettings({
    isOpen,
  });

  const defaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  const globalRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);

  // --- Hook: Branch Input ---
  const {
    branchInput,
    setBranchInput,
    branchInputTouchedRef,
    selectedIssue,
    issueTouchedRef,
    fromRemote,
    setFromRemote,
    newBranchInputRef,
    parsedBranch,
    handleIssueSelect,
    markBranchInputTouched,
  } = useBranchInput({
    isOpen,
    initialIssue,
    initialPR,
    configuredBranchPrefix,
  });

  const canAssignIssue = Boolean(currentUser && selectedIssue);

  // --- Hook: Branch Validation ---
  const onBranchAutoResolved = useCallback(
    (resolvedName: string) => setBranchInput(resolvedName),
    [setBranchInput]
  );

  const {
    isCheckingBranch,
    isGeneratingPath,
    worktreePath,
    setWorktreePath,
    branchWasAutoResolved,
    pathWasAutoResolved,
    pathTouchedRef,
  } = useBranchValidation({
    branchInput,
    rootPath,
    isOpen,
    onBranchAutoResolved,
  });

  // --- Hook: Branch Picker ---
  const onSelectBranch = useCallback(
    (name: string, isRemote: boolean) => {
      setBaseBranch(name);
      setFromRemote(isRemote);
    },
    [setFromRemote]
  );

  const {
    branchPickerOpen,
    setBranchPickerOpen,
    branchQuery,
    setBranchQuery,
    selectedIndex,
    recentBranchNames: _recentBranchNames,
    setRecentBranchNames,
    branchInputRef,
    branchListRef,
    branchOptions,
    branchRows,
    selectableRows,
    selectedBranchOption,
    handleBranchKeyDown,
    handleBranchSelect,
  } = useBranchPicker({
    branches,
    baseBranch,
    onSelectBranch,
  });

  // --- Hook: Prefix Picker ---
  const onSelectPrefix = useCallback(
    (newValue: string) => {
      setBranchInput(newValue);
      markBranchInputTouched();
    },
    [setBranchInput, markBranchInputTouched]
  );

  const {
    prefixPickerOpen,
    setPrefixPickerOpen,
    prefixSelectedIndex,
    prefixSuggestions,
    prefixListRef,
    handlePrefixKeyDown,
    handlePrefixSelect,
  } = usePrefixPicker({
    branchInput,
    onSelectPrefix,
    newBranchInputRef,
  });

  // --- Hook: Recipe Picker ---
  const {
    selectedRecipeId,
    setSelectedRecipeId,
    recipePickerOpen,
    setRecipePickerOpen,
    recipeSelectionTouchedRef,
    selectedRecipe,
  } = useRecipePicker({
    isOpen,
    defaultRecipeId,
    globalRecipes,
    lastSelectedWorktreeRecipeId,
    projectId,
    initialRecipeId,
    setLastSelectedWorktreeRecipeIdByProject,
  });

  // --- GitHub config initialization ---
  useEffect(() => {
    initializeGitHubConfig();
  }, [initializeGitHubConfig]);

  useEffect(() => {
    if (!isOpen) return;
    if (githubConfig?.hasToken && !githubConfig.username) {
      refreshGitHubConfig();
    }
  }, [isOpen, githubConfig?.hasToken, githubConfig?.username, refreshGitHubConfig]);

  // --- Bootstrap: load branches and reset top-level state on open ---
  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setValidationError(null);
    setCreationError(null);
    setPrBranchResolved(null);
    setBranches([]);
    setBaseBranch("");
    setIsDismissing(false);

    let isCurrent = true;

    worktreeClient
      .getRecentBranches(rootPath)
      .then((recent) => {
        if (isCurrent) setRecentBranchNames(recent);
      })
      .catch(() => {
        if (isCurrent) setRecentBranchNames([]);
      });

    worktreeClient
      .listBranches(rootPath)
      .then((branchList) => {
        if (!isCurrent) return;

        setBranches(branchList);

        if (initialPR?.headRefName) {
          const remoteBranchName = `origin/${initialPR.headRefName}`;
          const remoteBranch = branchList.find((b) => b.name === remoteBranchName);
          const localBranch = branchList.find((b) => b.name === initialPR.headRefName && !b.remote);
          if (remoteBranch) {
            setBaseBranch(remoteBranchName);
            setFromRemote(true);
            setPrBranchResolved(true);
          } else if (localBranch) {
            setBaseBranch(localBranch.name);
            setFromRemote(false);
            setPrBranchResolved(true);
          } else {
            setPrBranchResolved(false);
            const mainBranch =
              branchList.find((b) => b.name === "main") ||
              branchList.find((b) => b.name === "master");
            const fallback = mainBranch?.name || branchList[0]?.name || "";
            setBaseBranch(fallback);
            setFromRemote(false);
          }
        } else {
          const currentBranch = branchList.find((b) => b.current);
          const mainBranch =
            branchList.find((b) => b.name === "main") ||
            branchList.find((b) => b.name === "master");

          const initialBranch =
            currentBranch?.name || mainBranch?.name || branchList[0]?.name || "";
          setBaseBranch(initialBranch);

          const initialBranchInfo = branchList.find((b) => b.name === initialBranch);
          setFromRemote(!!initialBranchInfo?.remote);
        }
      })
      .catch((err) => {
        if (!isCurrent) return;
        setValidationError(`Failed to load branches: ${err.message}`);
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
  }, [isOpen, rootPath, initialIssue, initialPR, setFromRemote, setRecentBranchNames]);

  // Focus new branch input after loading
  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [isOpen, loading, newBranchInputRef]);

  // --- Form dirty check and dismiss guard ---
  const isFormDirty = useMemo(
    () => {
      if (branchInputTouchedRef.current && branchInput.trim()) return true;
      if (issueTouchedRef.current && selectedIssue !== null) return true;
      if (recipeSelectionTouchedRef.current) return true;
      if (pathTouchedRef.current && worktreePath.trim()) return true;
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [branchInput, worktreePath, selectedIssue, selectedRecipeId]
  );

  const handleBeforeClose = useCallback((): boolean => {
    if (!isFormDirty) return true;
    if (isDismissing) {
      setIsDismissing(false);
      return false;
    }
    setIsDismissing(true);
    return false;
  }, [isFormDirty, isDismissing]);

  const handleRequestClose = useCallback(() => {
    if (handleBeforeClose()) onClose();
  }, [handleBeforeClose, onClose]);

  useEffect(() => {
    if (isDismissing) {
      requestAnimationFrame(() => keepEditingButtonRef.current?.focus());
    }
  }, [isDismissing]);

  // --- Create handler ---
  const handleCreate = () => {
    if (!baseBranch) {
      setValidationError("Please select a base branch");
      return;
    }

    const trimmedInput = branchInput.trim();
    if (!trimmedInput) {
      setValidationError("Please enter a branch name");
      return;
    }

    const parsed = parseBranchInput(trimmedInput);

    if (parsed.hasPrefix) {
      if (!parsed.slug || !parsed.slug.trim()) {
        setValidationError("Please enter a branch name after the prefix");
        return;
      }
      if (
        /[\s.:]/.test(parsed.prefix) ||
        /^[.-]/.test(parsed.prefix) ||
        parsed.prefix.includes("..")
      ) {
        setValidationError("Branch prefix contains invalid characters");
        return;
      }
      if (/[\s.]$/.test(parsed.slug) || /^[.-]/.test(parsed.slug)) {
        setValidationError("Branch name cannot start with '.', '-' or end with space or '.'");
        return;
      }
      if (/[\\:]/.test(parsed.slug) || parsed.slug.includes("..")) {
        setValidationError("Branch name contains invalid characters");
        return;
      }
    } else {
      if (/[\s.]$/.test(trimmedInput) || /^[.-]/.test(trimmedInput)) {
        setValidationError("Branch name cannot start with '.', '-' or end with space or '.'");
        return;
      }
      if (/[/\\:]/.test(trimmedInput) || trimmedInput.includes("..")) {
        setValidationError("Branch name contains invalid characters");
        return;
      }
    }

    if (!worktreePath.trim()) {
      setValidationError("Please enter a worktree path");
      return;
    }

    const fullBranchName = parsed.fullBranchName;

    setValidationError(null);
    setCreationError(null);

    startTransition(async () => {
      try {
        const useExistingBranch =
          initialPR !== null && initialPR !== undefined
            ? branches.some((b) => b.name === fullBranchName && !b.remote)
            : false;

        const options: CreateWorktreeOptions = {
          baseBranch,
          newBranch: fullBranchName,
          path: worktreePath.trim(),
          fromRemote: useExistingBranch ? false : fromRemote,
          useExistingBranch,
        };

        const result = await actionService.dispatch(
          "worktree.create",
          { rootPath, options },
          { source: "user" }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }

        const worktreeId = result.result as string;
        useWorktreeSelectionStore.getState().setPendingWorktree(worktreeId);
        useWorktreeSelectionStore.getState().selectWorktree(worktreeId);

        if (selectedIssue && assignWorktreeToSelf && currentUser) {
          try {
            await githubClient.assignIssue(rootPath, selectedIssue.number, currentUser);
          } catch (assignErr) {
            const message =
              assignErr instanceof Error ? assignErr.message : "Failed to assign issue";
            const issueUrl = selectedIssue.url;
            notify({
              type: "warning",
              title: "Could not assign issue",
              message: `${message} — you can assign it manually on GitHub`,
              actions: issueUrl
                ? [
                    {
                      label: "Assign on GitHub",
                      onClick: () => systemClient.openExternal(issueUrl),
                    },
                  ]
                : [],
            });
          }
        }

        if (selectedRecipe) {
          const worktreeId = result.result as string | undefined;
          try {
            await runRecipe(selectedRecipe.id, worktreePath.trim(), worktreeId, {
              issueNumber: selectedIssue?.number,
              worktreePath: worktreePath.trim(),
              branchName: fullBranchName,
            });
          } catch (recipeErr) {
            const message = recipeErr instanceof Error ? recipeErr.message : "Failed to run recipe";
            const recipeId = selectedRecipe.id;
            const recipePath = worktreePath.trim();
            const recipeWorktreeId = worktreeId;
            const recipeContext = {
              issueNumber: selectedIssue?.number,
              worktreePath: recipePath,
              branchName: fullBranchName,
            };
            notify({
              type: "warning",
              title: "Could not run recipe",
              message: `${message} — worktree was created successfully`,
              actions: [
                {
                  label: "Retry Recipe",
                  onClick: () => {
                    runRecipe(recipeId, recipePath, recipeWorktreeId, recipeContext).catch(
                      console.error
                    );
                  },
                },
              ],
            });
          }
        }

        onWorktreeCreated?.();
        onClose();

        setBranchInput("");
        setWorktreePath("");
        setFromRemote(false);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to create worktree";
        setCreationError(mapCreationError(message, onClose));
      }
    });
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={handleBeforeClose}
      size="md"
      dismissible={!isPending}
      data-testid="new-worktree-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<WorktreeIcon className="w-5 h-5 text-canopy-accent" />}>
          {initialPR ? "Checkout PR Branch" : "Create New Worktree"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="xl" className="text-canopy-accent" />
            <span className="ml-2 text-sm text-canopy-text/60">Loading branches...</span>
          </div>
        ) : (
          <TooltipProvider>
            <div className="space-y-4">
              {initialPR ? (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] bg-canopy-accent/5 border border-canopy-accent/20 text-sm min-w-0">
                  <WorktreeIcon
                    className="w-4 h-4 text-canopy-accent shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-canopy-text/80 min-w-0 truncate">
                    PR <span className="font-medium text-canopy-text">#{initialPR.number}</span> —{" "}
                    {initialPR.title}
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="block text-sm font-medium text-canopy-text">
                      Link Issue (Optional)
                    </label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="text-canopy-text/40 hover:text-canopy-text/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2"
                          aria-label="Help for Link Issue field"
                          disabled={isPending}
                        >
                          <Info className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="sr-only">Help for Link Issue field</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Select an issue to auto-generate a branch name</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <IssueSelector
                    projectPath={rootPath}
                    selectedIssue={selectedIssue}
                    onSelect={handleIssueSelect}
                    disabled={isPending}
                  />
                </div>
              )}

              {!initialPR && canAssignIssue && (
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
                      disabled={isPending}
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
                        isPending && "opacity-50 cursor-not-allowed"
                      )}
                    />
                  </label>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="base-branch"
                    className="block text-sm font-medium text-canopy-text"
                  >
                    Base Branch
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-canopy-text/40 hover:text-canopy-text/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2"
                        aria-label="Help for Base Branch field"
                        disabled={isPending}
                      >
                        <Info className="w-3.5 h-3.5" aria-hidden="true" />
                        <span className="sr-only">Help for Base Branch field</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>The branch to create the new worktree from</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Popover open={branchPickerOpen} onOpenChange={setBranchPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="base-branch"
                      variant="outline"
                      role="combobox"
                      aria-expanded={branchPickerOpen}
                      aria-haspopup="listbox"
                      className="w-full justify-between bg-canopy-bg border-canopy-border text-canopy-text hover:bg-canopy-bg hover:text-canopy-text"
                      disabled={isPending}
                    >
                      <span className="truncate">
                        {selectedBranchOption?.labelText || "Select base branch..."}
                      </span>
                      <ChevronsUpDown className="opacity-50 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[400px] p-0"
                    align="start"
                    onEscapeKeyDown={(e) => e.stopPropagation()}
                  >
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
                          selectableRows.length > 0 && selectedIndex >= 0
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
                      {selectableRows.length === 0 ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                          {branchQuery ? "No branches found" : "No branches available"}
                        </div>
                      ) : (
                        (() => {
                          let optionIndex = 0;
                          return branchRows.map((row) => {
                            if (row.kind === "section") {
                              return (
                                <div
                                  key={`section-${row.label}`}
                                  role="presentation"
                                  className="px-2 py-1 text-xs font-medium text-canopy-text/50 uppercase tracking-wider"
                                >
                                  {row.label}
                                </div>
                              );
                            }
                            const idx = optionIndex++;
                            return (
                              <div
                                key={row.name}
                                id={`branch-option-${idx}`}
                                data-option-index={idx}
                                role="option"
                                aria-selected={row.name === baseBranch}
                                onClick={() => {
                                  if (row.inUseWorktree) {
                                    actionService.dispatch("worktree.setActive", {
                                      worktreeId: row.inUseWorktree.id,
                                    });
                                    setBranchPickerOpen(false);
                                    onClose();
                                    return;
                                  }
                                  handleBranchSelect(row);
                                }}
                                className={cn(
                                  "flex items-center justify-between gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                                  row.name === baseBranch && "bg-canopy-border",
                                  idx === selectedIndex && "bg-canopy-accent/10"
                                )}
                              >
                                <span className="truncate">
                                  <HighlightBranchText
                                    text={row.labelText}
                                    matchRanges={row.matchRanges}
                                    nameLength={row.name.length}
                                  />
                                </span>
                                <span className="flex items-center gap-1 shrink-0">
                                  {row.inUseWorktree && (
                                    <span
                                      className="text-xs text-status-warning"
                                      title={`In use by worktree: ${row.inUseWorktree.name}`}
                                    >
                                      in use
                                    </span>
                                  )}
                                  {row.name === baseBranch && (
                                    <Check className="h-4 w-4 text-canopy-accent" />
                                  )}
                                </span>
                              </div>
                            );
                          });
                        })()
                      )}
                    </div>
                    {!branchQuery && branchOptions.length > 500 && (
                      <div className="border-t border-canopy-border px-3 py-2 text-xs text-canopy-text/60">
                        Showing first 500 branches. Type to search.
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <label htmlFor="new-branch" className="block text-sm font-medium text-canopy-text">
                  New Branch Name
                </label>
                <Popover open={prefixPickerOpen} onOpenChange={setPrefixPickerOpen}>
                  <PopoverTrigger asChild>
                    <div className="relative">
                      <input
                        ref={newBranchInputRef}
                        id="new-branch"
                        type="text"
                        data-testid="branch-name-input"
                        value={branchInput}
                        onChange={(e) => {
                          setBranchInput(e.target.value);
                          markBranchInputTouched();
                          setValidationError(null);
                          setCreationError(null);
                        }}
                        onKeyDown={handlePrefixKeyDown}
                        placeholder="feature/add-user-auth"
                        className="w-full px-3 pr-10 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono text-sm"
                        disabled={isPending}
                        aria-describedby={
                          branchWasAutoResolved ? "branch-resolved-hint" : undefined
                        }
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls="prefix-list"
                        aria-expanded={prefixPickerOpen}
                      />
                      {isCheckingBranch && (
                        <Spinner
                          size="md"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-canopy-text/40 pointer-events-none"
                        />
                      )}
                    </div>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-trigger-width)] p-0 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] shadow-[var(--theme-shadow-floating)]"
                    onOpenAutoFocus={(e) => e.preventDefault()}
                    onEscapeKeyDown={(e) => e.stopPropagation()}
                  >
                    <div
                      ref={prefixListRef}
                      id="prefix-list"
                      role="listbox"
                      className="max-h-[240px] overflow-y-auto p-1"
                    >
                      {prefixSuggestions.length === 0 ? (
                        <div className="py-4 text-center text-sm text-canopy-text/60">
                          No matching prefixes
                        </div>
                      ) : (
                        prefixSuggestions.map((suggestion, index) => (
                          <div
                            key={suggestion.type.prefix}
                            role="option"
                            aria-selected={index === prefixSelectedIndex}
                            onClick={() => handlePrefixSelect(suggestion.type.prefix)}
                            className={cn(
                              "flex items-center gap-2 px-2 py-1.5 text-sm rounded-[var(--radius-sm)] cursor-pointer hover:bg-canopy-border",
                              index === prefixSelectedIndex && "bg-canopy-accent/10"
                            )}
                          >
                            <span className="font-mono text-canopy-accent">
                              {suggestion.type.prefix}/
                            </span>
                            <span className="text-canopy-text/60">
                              {suggestion.type.displayName}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-canopy-text/60">
                  {parsedBranch.hasPrefix ? (
                    <>
                      <span className="font-mono text-canopy-accent">{parsedBranch.prefix}/</span>
                      <span className="font-mono">{parsedBranch.slug || "..."}</span>
                    </>
                  ) : (
                    <span className="font-mono">{parsedBranch.fullBranchName || "..."}</span>
                  )}
                </p>
                {branchWasAutoResolved && (
                  <p
                    id="branch-resolved-hint"
                    className="text-xs text-status-success flex items-center gap-1.5 mt-1"
                    role="status"
                    aria-live="polite"
                  >
                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                    Name auto-incremented to avoid conflict with existing branch
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="worktree-path"
                    className="block text-sm font-medium text-canopy-text"
                  >
                    Worktree Path
                  </label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-canopy-text/40 hover:text-canopy-text/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2"
                        aria-label="Help for Worktree Path field"
                        disabled={isPending}
                      >
                        <Info className="w-3.5 h-3.5" aria-hidden="true" />
                        <span className="sr-only">Help for Worktree Path field</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>Directory where the worktree will be created</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="relative flex-1">
                    <input
                      id="worktree-path"
                      data-testid="worktree-path-input"
                      type="text"
                      value={worktreePath}
                      onChange={(e) => {
                        setWorktreePath(e.target.value);
                        pathTouchedRef.current = true;
                        setValidationError(null);
                        setCreationError(null);
                      }}
                      placeholder="/path/to/worktree"
                      className="w-full px-3 pr-10 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
                      disabled={isPending}
                    />
                    {isGeneratingPath && (
                      <Spinner
                        size="md"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-canopy-text/40 pointer-events-none"
                      />
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await actionService.dispatch(
                          "project.openDialog",
                          undefined,
                          {
                            source: "user",
                          }
                        );
                        if (result.ok && result.result) {
                          setWorktreePath(result.result as string);
                          pathTouchedRef.current = true;
                          setValidationError(null);
                          setCreationError(null);
                        }
                      } catch (err: unknown) {
                        console.error("Failed to open directory picker:", err);
                        const message = err instanceof Error ? err.message : "Unknown error";
                        setValidationError(`Failed to open directory picker: ${message}`);
                      }
                    }}
                    disabled={isPending}
                  >
                    <FolderOpen />
                  </Button>
                </div>
                {pathWasAutoResolved && (
                  <p
                    className="text-xs text-status-success flex items-center gap-1.5 mt-1"
                    role="status"
                    aria-live="polite"
                  >
                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                    Path auto-incremented to avoid conflict with existing directory
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2">
                <input
                  id="from-remote"
                  type="checkbox"
                  checked={fromRemote}
                  onChange={(e) => setFromRemote(e.target.checked)}
                  className="rounded border-canopy-border text-canopy-accent focus:ring-canopy-accent"
                  disabled={isPending}
                />
                <label htmlFor="from-remote" className="text-sm text-canopy-text select-none">
                  Create from remote branch
                </label>
              </div>

              {globalRecipes.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label
                      htmlFor="recipe-selector"
                      className="block text-sm font-medium text-canopy-text"
                    >
                      Run Recipe (Optional)
                    </label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="text-canopy-text/40 hover:text-canopy-text/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-canopy-accent focus-visible:ring-offset-2"
                          aria-label="Help for Run Recipe field"
                          disabled={isPending}
                        >
                          <Info className="w-3.5 h-3.5" aria-hidden="true" />
                          <span className="sr-only">Help for Run Recipe field</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Select a recipe to run after creating the worktree</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
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
                        disabled={isPending}
                      >
                        <span className="flex items-center gap-2 truncate">
                          <Play className="shrink-0 text-canopy-accent" />
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
                        <ChevronsUpDown className="opacity-50 shrink-0" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-[400px] p-0"
                      align="start"
                      onEscapeKeyDown={(e) => e.stopPropagation()}
                    >
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
                              if (projectId)
                                setLastSelectedWorktreeRecipeIdByProject(projectId, null);
                              setRecipePickerOpen(false);
                            }
                          }}
                          onClick={() => {
                            recipeSelectionTouchedRef.current = true;
                            setSelectedRecipeId(null);
                            if (projectId)
                              setLastSelectedWorktreeRecipeIdByProject(projectId, null);
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
                                if (projectId)
                                  setLastSelectedWorktreeRecipeIdByProject(projectId, recipe.id);
                                setRecipePickerOpen(false);
                              }
                            }}
                            onClick={() => {
                              recipeSelectionTouchedRef.current = true;
                              setSelectedRecipeId(recipe.id);
                              if (projectId)
                                setLastSelectedWorktreeRecipeIdByProject(projectId, recipe.id);
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
                                <span className="text-xs text-canopy-accent shrink-0">
                                  (default)
                                </span>
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
                </div>
              )}

              {initialPR && prBranchResolved === false && (
                <div className="flex items-start gap-2 p-3 bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)]">
                  <AlertCircle className="w-4 h-4 text-status-warning mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-status-warning">
                    Branch <span className="font-mono">{initialPR.headRefName ?? "unknown"}</span>{" "}
                    has not been fetched from the remote yet. Run{" "}
                    <span className="font-mono">git fetch origin</span> and reopen this dialog.
                  </p>
                </div>
              )}

              {validationError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)]"
                >
                  <AlertCircle className="w-4 h-4 text-status-error mt-0.5 flex-shrink-0" />
                  <p className="text-sm text-status-error">{validationError}</p>
                </div>
              )}

              {creationError && (
                <div
                  role="alert"
                  className="p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)] space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-status-error mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-status-error">{creationError.friendly}</p>
                  </div>
                  {creationError.recovery && (
                    <button
                      type="button"
                      onClick={creationError.recovery.onAction}
                      className="ml-6 text-xs font-medium text-status-error underline underline-offset-2 hover:text-status-error/80"
                    >
                      {creationError.recovery.label}
                    </button>
                  )}
                  {creationError.raw !== creationError.friendly && (
                    <details className="ml-6">
                      <summary className="flex items-center gap-1 text-xs text-canopy-text/50 cursor-pointer select-none">
                        <ChevronDown className="w-3 h-3" />
                        Show details
                      </summary>
                      <pre className="mt-1.5 overflow-x-auto rounded bg-status-error/5 p-2 font-mono text-[11px] text-canopy-text/50 whitespace-pre-wrap break-all select-text">
                        {creationError.raw}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          </TooltipProvider>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {isDismissing ? (
          <>
            <span role="alert" className="flex-1 text-sm text-canopy-text/70">
              Discard unsaved changes?
            </span>
            <Button
              ref={keepEditingButtonRef}
              variant="ghost"
              onClick={() => setIsDismissing(false)}
            >
              Keep Editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={handleRequestClose} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                isPending ||
                loading ||
                isCheckingBranch ||
                isGeneratingPath ||
                (initialPR !== null && initialPR !== undefined && prBranchResolved === false)
              }
              className="min-w-[100px]"
              data-testid="create-worktree-button"
            >
              {isPending ? (
                <>
                  <Spinner />
                  Creating...
                </>
              ) : creationError ? (
                <>
                  <Check />
                  Retry
                </>
              ) : (
                <>
                  <Check />
                  Create
                </>
              )}
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
