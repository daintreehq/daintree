import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderGit2, Check, AlertCircle } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
// eslint-disable-next-line no-restricted-imports
import { worktreeClient, githubClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "@github-renderer/stores/githubConfigStore";
import { notify } from "@/lib/notify";
import { systemClient } from "@/clients/systemClient";
import { useRecipeStore } from "@/store/recipeStore";
import { logError } from "@/utils/logger";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useNewWorktreeProjectSettings } from "./hooks/useNewWorktreeProjectSettings";
import { useBranchInput } from "./hooks/useBranchInput";
import { useBranchValidation } from "./hooks/useBranchValidation";
import { useBranchPicker } from "./hooks/useBranchPicker";
import { usePrefixPicker } from "./hooks/usePrefixPicker";
import { useRecipePicker, CLONE_LAYOUT_ID } from "./hooks/useRecipePicker";
import { useWorktreeFormErrors } from "./hooks/useWorktreeFormErrors";
import { useWorktreeFormValidation } from "./hooks/useWorktreeFormValidation";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { spawnPanelsFromRecipe } from "./panelSpawning";

import {
  PrHeader,
  IssueLinkerView,
  BranchModeControl,
  BaseBranchCombobox,
  ExistingBranchPicker,
  NewBranchInput,
  WorktreePathPicker,
  EnvironmentRadioGroup,
  RecipePickerPopover,
} from "./views";

type BranchMode = "new" | "existing";

interface NewWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rootPath: string;
  onWorktreeCreated?: (worktreeId: string) => void;
  initialIssue?: GitHubIssue | null;
  initialPR?: GitHubPR | null;
  initialRecipeId?: string | null;
  initialBranchInput?: string | null;
}

export function NewWorktreeDialog({
  isOpen,
  onClose,
  rootPath,
  onWorktreeCreated,
  initialIssue,
  initialPR,
  initialRecipeId,
  initialBranchInput,
}: NewWorktreeDialogProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [prBranchResolved, setPrBranchResolved] = useState<boolean | null>(null);
  const [isDismissing, setIsDismissing] = useState(false);
  const [branchMode, setBranchMode] = useState<BranchMode>("new");
  const [selectedExistingBranch, setSelectedExistingBranch] = useState<string | null>(null);
  const [existingBranchPickerOpen, setExistingBranchPickerOpen] = useState(false);
  const [existingBranchQuery, setExistingBranchQuery] = useState("");
  const [worktreeMode, setWorktreeMode] = useState<string>("local");
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const isCreatingRef = useRef(false);

  const { errors, setValidationError, clearErrors, markTouched, resetErrors } =
    useWorktreeFormErrors();

  const assignWorktreeToSelf = usePreferencesStore((s) => s.assignWorktreeToSelf);
  const setAssignWorktreeToSelf = usePreferencesStore((s) => s.setAssignWorktreeToSelf);
  const lastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.lastSelectedWorktreeRecipeIdByProject
  );
  const setLastSelectedWorktreeRecipeIdByProject = usePreferencesStore(
    (s) => s.setLastSelectedWorktreeRecipeIdByProject
  );
  const worktreeMap = useWorktreeStore((s) => s.worktrees);
  const githubConfig = useGitHubConfigStore((s) => s.config);
  const initializeGitHubConfig = useGitHubConfigStore((s) => s.initialize);
  const refreshGitHubConfig = useGitHubConfigStore((s) => s.refresh);
  const { recipes, runRecipe } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];

  const currentUser = githubConfig?.username;
  const currentUserAvatar = githubConfig?.avatarUrl;

  const { projectSettings, configuredBranchPrefix } = useNewWorktreeProjectSettings({ isOpen });

  const resourceEnvironments = projectSettings?.resourceEnvironments;
  const hasAnyEnvironments = Object.keys(resourceEnvironments ?? {}).length > 0;

  const defaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  const globalRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);

  const {
    branchInput,
    setBranchInput,
    branchInputTouchedRef,
    selectedIssue,
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

  // Retry-prefill: when the sidebar's error placeholder reopens the dialog with
  // a remembered branch, seed the input AFTER useBranchInput's reset runs.
  // Marking the touched ref blocks the auto-prefix and auto-slug effects so
  // they don't overwrite the prefilled value.
  const appliedInitialBranchRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      appliedInitialBranchRef.current = false;
      return;
    }
    if (appliedInitialBranchRef.current) return;
    if (!initialBranchInput) return;
    appliedInitialBranchRef.current = true;
    setBranchInput(initialBranchInput);
    branchInputTouchedRef.current = true;
  }, [isOpen, initialBranchInput, setBranchInput, branchInputTouchedRef]);

  const canAssignIssue = Boolean(currentUser && selectedIssue);

  const onBranchAutoResolved = useCallback(
    (resolvedName: string) => setBranchInput(resolvedName),
    [setBranchInput]
  );

  const isExistingMode = branchMode === "existing" && !initialPR;

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
    skipAvailabilityCheck: isExistingMode,
    overrideBranchName: isExistingMode ? (selectedExistingBranch ?? "") : undefined,
  });

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

  const existingBranchCandidates = useMemo(() => {
    const inUseSet = new Set<string>();
    for (const wt of worktreeMap.values()) {
      if (wt.branch) inUseSet.add(wt.branch);
    }
    return branches.filter((b) => !b.remote && !inUseSet.has(b.name));
  }, [branches, worktreeMap]);

  const filteredExistingBranches = useMemo(() => {
    const q = existingBranchQuery.trim().toLowerCase();
    if (!q) return existingBranchCandidates;
    return existingBranchCandidates.filter((b) => b.name.toLowerCase().includes(q));
  }, [existingBranchCandidates, existingBranchQuery]);

  const handleBranchModeChange = useCallback(
    (mode: BranchMode) => {
      setBranchMode(mode);
      setSelectedExistingBranch(null);
      setExistingBranchQuery("");
      clearErrors();
    },
    [clearErrors]
  );

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
    resetErrors();
    setPrBranchResolved(null);
    setBranches([]);
    setBaseBranch("");
    setIsDismissing(false);
    setBranchMode("new");
    setSelectedExistingBranch(null);
    setExistingBranchQuery("");
    setWorktreeMode("local");
    isCreatingRef.current = false;
    // resetErrors() is NOT called here — touched refs are managed by individual hooks

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
      .then(async (branchList) => {
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
            try {
              await worktreeClient.fetchPRBranch(rootPath, initialPR.number, initialPR.headRefName);
              if (!isCurrent) return;
              const updatedBranches = await worktreeClient.listBranches(rootPath);
              if (!isCurrent) return;
              setBranches(updatedBranches);
              const fetchedLocal = updatedBranches.find(
                (b) => b.name === initialPR.headRefName && !b.remote
              );
              if (fetchedLocal) {
                setBaseBranch(fetchedLocal.name);
                setFromRemote(false);
                setPrBranchResolved(true);
              } else {
                setPrBranchResolved(false);
                const mainBranch =
                  updatedBranches.find((b) => b.name === "main") ||
                  updatedBranches.find((b) => b.name === "master");
                setBaseBranch(mainBranch?.name || updatedBranches[0]?.name || "");
                setFromRemote(false);
              }
            } catch {
              if (!isCurrent) return;
              setPrBranchResolved(false);
              const mainBranch =
                branchList.find((b) => b.name === "main") ||
                branchList.find((b) => b.name === "master");
              const fallback = mainBranch?.name || branchList[0]?.name || "";
              setBaseBranch(fallback);
              setFromRemote(false);
            }
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
        setValidationError(`Failed to load branches: ${err.message}`, null);
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
  }, [
    isOpen,
    rootPath,
    initialIssue,
    initialPR,
    setFromRemote,
    setRecentBranchNames,
    setValidationError,
    clearErrors,
  ]);

  // Initialize worktreeMode when projectSettings loads asynchronously
  const settingsDefaultMode = projectSettings?.defaultWorktreeMode;
  const settingsResourceEnvs = projectSettings?.resourceEnvironments;
  useEffect(() => {
    if (!isOpen) return;
    const defaultMode = settingsDefaultMode ?? "local";
    const envKeys = Object.keys(settingsResourceEnvs ?? {});
    if (defaultMode !== "local" && envKeys.includes(defaultMode)) {
      setWorktreeMode(defaultMode);
    }
  }, [isOpen, settingsDefaultMode, settingsResourceEnvs]);

  // Focus new branch input after loading
  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [isOpen, loading, newBranchInputRef]);

  // --- Form dirty check and dismiss guard ---
  const formDirty = useMemo(() => {
    if (selectedExistingBranch !== null) return true;
    if (errors.touchedFields.branchInput && branchInput.trim()) return true;
    if (errors.touchedFields.issue && selectedIssue !== null) return true;
    if (errors.touchedFields.recipe) return true;
    if (errors.touchedFields.worktreePath && worktreePath.trim()) return true;
    if (worktreeMode !== "local") return true;
    return false;
  }, [
    branchInput,
    worktreePath,
    selectedIssue,
    selectedExistingBranch,
    worktreeMode,
    errors.touchedFields,
  ]);

  const handleBeforeClose = useCallback((): boolean => {
    if (!formDirty) return true;
    if (isDismissing) {
      setIsDismissing(false);
      return false;
    }
    setIsDismissing(true);
    return false;
  }, [formDirty, isDismissing]);

  const handleRequestClose = useCallback(() => {
    if (handleBeforeClose()) onClose();
  }, [handleBeforeClose, onClose]);

  useEffect(() => {
    if (isDismissing) {
      requestAnimationFrame(() => keepEditingButtonRef.current?.focus());
    }
  }, [isDismissing]);

  // --- Validation hook ---
  const { validate } = useWorktreeFormValidation();

  // --- Create handler ---
  const handleCreate = () => {
    if (isCreatingRef.current) return;
    isCreatingRef.current = true;

    const result = validate({
      branchMode,
      baseBranch,
      branchInput,
      selectedExistingBranch,
      worktreePath,
    });

    if (!result.valid) {
      setValidationError(result.error!.message, result.error!.field);
      isCreatingRef.current = false;
      return;
    }

    clearErrors();

    const fullBranchName = isExistingMode ? selectedExistingBranch! : result.fullBranchName!;

    const snapBranchMode = branchMode;
    const snapUseExisting = snapBranchMode === "existing";
    const snapFromRemote = fromRemote;
    const snapWorktreePath = worktreePath.trim();
    const snapWorktreeMode = worktreeMode;
    const snapIssue = selectedIssue;
    const snapRecipeId = selectedRecipeId;
    const snapSelectedRecipe = selectedRecipe;
    const snapInitialPR = initialPR;
    const snapBranches = branches;
    const snapAssignToSelf = assignWorktreeToSelf;
    const snapCurrentUser = currentUser;
    const snapBaseBranch = baseBranch;
    // Anchor the sidebar placeholder by the path the host will normalize to as
    // the worktree id. Relative paths can't anchor a placeholder because the
    // host resolves them server-side, so the renderer-keyed Map entry would
    // never match the `worktree-update` event id. Skip the placeholder for
    // that case rather than risk a stuck row.
    const placeholderPath = snapWorktreePath.startsWith("/") ? snapWorktreePath : null;
    const selectionStore = useWorktreeSelectionStore.getState();

    if (placeholderPath) {
      selectionStore.addPendingCreation(placeholderPath, { branch: fullBranchName });
    }

    onClose();

    // Reset locally-captured form state so the next dialog open starts clean.
    setBranchInput("");
    setWorktreePath("");
    setFromRemote(false);

    void (async () => {
      try {
        const sourceWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

        const useExistingBranch =
          snapUseExisting ||
          (snapInitialPR !== null && snapInitialPR !== undefined
            ? snapBranches.some((b) => b.name === fullBranchName && !b.remote)
            : false);

        const options: CreateWorktreeOptions = {
          baseBranch: snapUseExisting ? selectedExistingBranch! : snapBaseBranch,
          newBranch: fullBranchName,
          path: snapWorktreePath,
          fromRemote: useExistingBranch ? false : snapFromRemote,
          useExistingBranch,
          provisionResource: snapWorktreeMode !== "local" || undefined,
          worktreeMode: snapWorktreeMode,
        };

        const actionResult = await actionService.dispatch(
          "worktree.create",
          { rootPath, options },
          { source: "user" }
        );
        if (!actionResult.ok) {
          throw new Error(actionResult.error.message);
        }

        const worktreeId = actionResult.result as string;
        useWorktreeSelectionStore.getState().setPendingWorktree(worktreeId);
        useWorktreeSelectionStore.getState().selectWorktree(worktreeId);

        if (!snapUseExisting && snapIssue && snapAssignToSelf && snapCurrentUser) {
          try {
            await githubClient.assignIssue(rootPath, snapIssue.number, snapCurrentUser);
          } catch (assignErr) {
            const message = formatErrorMessage(assignErr, "Failed to assign issue");
            const issueUrl = snapIssue.url;
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

        if (snapRecipeId === CLONE_LAYOUT_ID && sourceWorktreeId) {
          try {
            const terminals = useRecipeStore
              .getState()
              .generateRecipeFromActiveTerminals(sourceWorktreeId);
            await spawnPanelsFromRecipe({ terminals, worktreeId, cwd: snapWorktreePath });
          } catch (cloneErr) {
            const message = formatErrorMessage(cloneErr, "Failed to clone layout");
            notify({
              type: "warning",
              title: "Could not clone layout",
              message: `${message} — worktree was created successfully`,
            });
          }
        } else if (snapSelectedRecipe) {
          try {
            await runRecipe(snapSelectedRecipe.id, snapWorktreePath, worktreeId, {
              issueNumber: snapIssue?.number,
              prNumber: snapInitialPR?.number,
              worktreePath: snapWorktreePath,
              branchName: fullBranchName,
            });
          } catch (recipeErr) {
            const message = formatErrorMessage(recipeErr, "Failed to run recipe");
            const recipeId = snapSelectedRecipe.id;
            const recipePath = snapWorktreePath;
            const recipeWorktreeId = worktreeId;
            const recipeContext = {
              issueNumber: snapIssue?.number,
              prNumber: snapInitialPR?.number,
              worktreePath: recipePath,
              branchName: fullBranchName,
            };
            notify({
              type: "warning",
              title: "Could not run recipe",
              message: `${message} — worktree was created successfully`,
              actions: [
                {
                  label: "Retry recipe",
                  onClick: () => {
                    runRecipe(recipeId, recipePath, recipeWorktreeId, recipeContext).catch((err) =>
                      logError("Failed to run recipe", err)
                    );
                  },
                },
              ],
            });
          }
        }

        onWorktreeCreated?.(worktreeId);
      } catch (err: unknown) {
        const message = formatErrorMessage(err, "Failed to create worktree");
        if (placeholderPath) {
          useWorktreeSelectionStore.getState().failPendingCreation(placeholderPath, message);
        } else {
          // No placeholder anchor (relative path edge case) — surface as a toast
          // since the dialog is already closed. No recovery action: the sidebar's
          // Create button is the retry surface; this path is rare enough that
          // hard-wiring a "Retry" action isn't worth the complexity.
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Couldn't create worktree",
            message,
          });
        }
      } finally {
        isCreatingRef.current = false;
      }
    })();
  };

  // --- Callback wrappers for view components ---
  const handleBranchInputChange = useCallback(
    (value: string) => {
      setBranchInput(value);
      markBranchInputTouched();
      markTouched("branchInput");
      clearErrors();
    },
    [setBranchInput, markBranchInputTouched, markTouched, clearErrors]
  );

  const handleWorktreePathChange = useCallback(
    (value: string) => {
      setWorktreePath(value);
      pathTouchedRef.current = true;
      markTouched("worktreePath");
      clearErrors();
    },
    [setWorktreePath, pathTouchedRef, markTouched, clearErrors]
  );

  const handleBrowseClick = useCallback(async () => {
    try {
      const result = await actionService.dispatch("project.openDialog", undefined, {
        source: "user",
      });
      if (result.ok && result.result) {
        setWorktreePath(result.result as string);
        pathTouchedRef.current = true;
        markTouched("worktreePath");
        clearErrors();
      }
    } catch (err: unknown) {
      logError("Failed to open directory picker", err);
      const message = formatErrorMessage(err, "Failed to open directory picker");
      setValidationError(`Failed to open directory picker: ${message}`, null);
    }
  }, [setWorktreePath, pathTouchedRef, markTouched, clearErrors, setValidationError]);

  const handleRecipeSelect = useCallback(
    (id: string | null) => {
      recipeSelectionTouchedRef.current = true;
      markTouched("recipe");
      setSelectedRecipeId(id);
      if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, id);
      clearErrors();
    },
    [
      recipeSelectionTouchedRef,
      markTouched,
      setSelectedRecipeId,
      projectId,
      setLastSelectedWorktreeRecipeIdByProject,
      clearErrors,
    ]
  );

  const handleExistingBranchSelect = useCallback(
    (branchName: string) => {
      setSelectedExistingBranch(branchName);
      clearErrors();
    },
    [clearErrors]
  );

  const handlePrefixSelectWrap = useCallback(
    (suggestion: { type: { prefix: string; displayName: string } }) => {
      handlePrefixSelect(suggestion.type.prefix);
      markTouched("branchInput");
    },
    [handlePrefixSelect, markTouched]
  );

  const handleIssueSelectWrapper = useCallback(
    (issue: GitHubIssue | null) => {
      handleIssueSelect(issue);
      if (issue) markTouched("issue");
      clearErrors();
    },
    [handleIssueSelect, markTouched, clearErrors]
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={handleBeforeClose}
      size="md"
      data-testid="new-worktree-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<FolderGit2 className="w-5 h-5 text-daintree-accent" />}>
          {initialPR ? "Checkout PR Branch" : "Create New Worktree"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        {loading ? (
          <Skeleton label="Loading branches" className="space-y-4 py-2">
            <div className="space-y-2">
              <SkeletonBone className="h-4 w-24" />
              <SkeletonBone className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <SkeletonBone className="h-4 w-28" />
              <SkeletonBone className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <SkeletonBone className="h-4 w-20" />
              <SkeletonBone className="h-9 w-full" />
            </div>
          </Skeleton>
        ) : (
          <div className="space-y-4">
            {initialPR ? (
              <PrHeader pr={initialPR} />
            ) : (
              <IssueLinkerView
                projectPath={rootPath}
                selectedIssue={selectedIssue}
                onSelectIssue={handleIssueSelectWrapper}
                canAssignIssue={canAssignIssue}
                assignWorktreeToSelf={assignWorktreeToSelf}
                onSetAssignWorktreeToSelf={setAssignWorktreeToSelf}
                currentUser={currentUser}
                currentUserAvatar={currentUserAvatar}
              />
            )}

            {!initialPR && (
              <BranchModeControl branchMode={branchMode} onChange={handleBranchModeChange} />
            )}

            {!isExistingMode && (
              <BaseBranchCombobox
                baseBranch={baseBranch}
                branchPickerOpen={branchPickerOpen}
                onOpenChange={setBranchPickerOpen}
                branchQuery={branchQuery}
                onQueryChange={setBranchQuery}
                branchRows={branchRows}
                selectableRows={selectableRows}
                selectedIndex={selectedIndex}
                selectedBranchLabel={selectedBranchOption?.labelText}
                onKeyDown={handleBranchKeyDown}
                onSelect={handleBranchSelect}
                branchInputRef={branchInputRef}
                branchListRef={branchListRef}
                errorField={errors.errorField}
                branchOptionsLength={branchOptions.length}
                onClose={onClose}
              />
            )}

            {isExistingMode ? (
              <ExistingBranchPicker
                open={existingBranchPickerOpen}
                onOpenChange={setExistingBranchPickerOpen}
                selectedBranch={selectedExistingBranch}
                query={existingBranchQuery}
                onQueryChange={setExistingBranchQuery}
                filteredBranches={filteredExistingBranches}
                onSelect={handleExistingBranchSelect}
              />
            ) : (
              <NewBranchInput
                value={branchInput}
                onChange={handleBranchInputChange}
                isCheckingBranch={isCheckingBranch}
                errorField={errors.errorField}
                branchWasAutoResolved={branchWasAutoResolved}
                parsedBranch={parsedBranch}
                prefixPickerOpen={prefixPickerOpen}
                onPrefixPickerOpenChange={setPrefixPickerOpen}
                prefixSuggestions={prefixSuggestions}
                prefixSelectedIndex={prefixSelectedIndex}
                onPrefixKeyDown={handlePrefixKeyDown}
                onPrefixSelect={handlePrefixSelectWrap}
                prefixListRef={prefixListRef}
                inputRef={newBranchInputRef}
              />
            )}

            <WorktreePathPicker
              value={worktreePath}
              onChange={handleWorktreePathChange}
              isGeneratingPath={isGeneratingPath}
              errorField={errors.errorField}
              pathWasAutoResolved={pathWasAutoResolved}
              onBrowseClick={handleBrowseClick}
            />

            {!isExistingMode && (
              <div className="flex items-center gap-2">
                <input
                  id="from-remote"
                  type="checkbox"
                  checked={fromRemote}
                  onChange={(e) => setFromRemote(e.target.checked)}
                  className="rounded border-daintree-border text-daintree-accent focus:ring-daintree-accent"
                />
                <label htmlFor="from-remote" className="text-sm text-daintree-text select-none">
                  Create from remote branch
                </label>
              </div>
            )}

            <EnvironmentRadioGroup
              worktreeMode={worktreeMode}
              onChange={setWorktreeMode}
              resourceEnvironments={resourceEnvironments}
              hasAnyEnvironments={hasAnyEnvironments}
            />

            {globalRecipes.length > 0 && (
              <RecipePickerPopover
                recipes={globalRecipes}
                selectedRecipeId={selectedRecipeId}
                selectedRecipe={selectedRecipe}
                defaultRecipeId={defaultRecipeId}
                open={recipePickerOpen}
                onOpenChange={setRecipePickerOpen}
                onSelectRecipe={handleRecipeSelect}
                onMarkTouched={() => {
                  markTouched("recipe");
                }}
                label="Run Recipe (Optional)"
                listId="recipe-selector"
              />
            )}

            {initialPR && prBranchResolved === false && (
              <div className="flex items-start gap-2 p-3 bg-status-warning/10 border border-status-warning/20 rounded-[var(--radius-md)]">
                <AlertCircle className="w-4 h-4 text-status-warning mt-0.5 flex-shrink-0" />
                <p className="text-sm text-status-warning">
                  Could not fetch branch{" "}
                  <span className="font-mono">{initialPR.headRefName ?? "unknown"}</span> from the
                  remote. The worktree will be created from the fallback branch instead. You can try
                  running <span className="font-mono">git fetch origin</span> manually and reopening
                  this dialog.
                </p>
              </div>
            )}

            {errors.validationError && (
              <div
                id="validation-error"
                role="alert"
                className="flex items-start gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-[var(--radius-md)]"
              >
                <AlertCircle className="w-4 h-4 text-status-error mt-0.5 flex-shrink-0" />
                <p className="text-sm text-status-error">{errors.validationError}</p>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        {isDismissing ? (
          <>
            <span role="alert" className="flex-1 text-sm text-daintree-text/70">
              Discard unsaved changes?
            </span>
            <Button
              ref={keepEditingButtonRef}
              variant="ghost"
              onClick={() => setIsDismissing(false)}
            >
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={handleRequestClose}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                loading ||
                isCheckingBranch ||
                isGeneratingPath ||
                (isExistingMode && !selectedExistingBranch) ||
                (initialPR !== null && initialPR !== undefined && prBranchResolved === false)
              }
              className="min-w-[100px]"
              data-testid="create-worktree-button"
            >
              <Check />
              Create
            </Button>
          </>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
