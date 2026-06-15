import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderGit2, Check, AlertCircle } from "lucide-react";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { Issue, PR } from "@shared/types/forge";

import { worktreeClient, forgeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { usePreferencesStore } from "@/store/preferencesStore";
import { notify } from "@/lib/notify";
import { mutateCacheEntries } from "@/lib/forgeResourceCache";
import { systemClient } from "@/clients/systemClient";
import { useRecipeStore } from "@/store/recipeStore";
import { notifyRecipeSpawnFailures } from "@/utils/recipeNotify";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
import { extractClosingIssueNumber } from "@/utils/closingIssueRef";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";
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

const branchListCache = new Map<string, BranchInfo[]>();

export function clearBranchListCache(): void {
  branchListCache.clear();
}

function deriveDefaultBaseBranch(branchList: BranchInfo[]): {
  name: string;
  fromRemote: boolean;
} {
  const currentBranch = branchList.find((b) => b.current);
  const mainBranch =
    branchList.find((b) => b.name === "main") || branchList.find((b) => b.name === "master");
  const name = currentBranch?.name || mainBranch?.name || branchList[0]?.name || "";
  const info = branchList.find((b) => b.name === name);
  return { name, fromRemote: !!info?.remote };
}

/** Collapse the normalized forge PR state to the workspace-host form (declined folds into closed). */
function normalizeSourcePrState(state: PR["state"]): "open" | "closed" | "merged" {
  switch (state) {
    case "merged":
      return "merged";
    case "closed":
    case "declined":
      return "closed";
    default:
      return "open";
  }
}

interface NewWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  rootPath: string;
  onWorktreeCreated?: (worktreeId: string) => void;
  initialIssue?: Issue | null;
  initialPR?: PR | null;
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
  const baseBranchTouchedRef = useRef(false);

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
  const inUseBranches = useWorktreeStore(
    useShallow((s) => {
      const names: string[] = [];
      for (const wt of s.worktrees.values()) {
        if (wt.branch) names.push(wt.branch);
      }
      return names.sort();
    })
  );
  const recipes = useRecipeStore((s) => s.recipes);
  const runRecipeWithResults = useRecipeStore((s) => s.runRecipeWithResults);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];
  const { entry: forgeEntry } = useResolvedForgeProvider(currentProject?.id ?? null);
  const forgeName = forgeEntry?.contribution.name ?? "the forge";

  // Forge-agnostic viewer identity, resolved per-cwd via the active forge
  // provider's `identity` capability so every project mirrors through the
  // right identity. `null` means "no token / unsupported".
  const [currentUser, setCurrentUser] = useState<string | undefined>(undefined);
  const [currentUserAvatar, setCurrentUserAvatar] = useState<string | undefined>(undefined);

  const { projectSettings, configuredBranchPrefix } = useNewWorktreeProjectSettings({ isOpen });

  const resourceEnvironments = projectSettings?.resourceEnvironments;
  const hasAnyEnvironments = Object.keys(resourceEnvironments ?? {}).length > 0;

  const defaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  const globalRecipes = useMemo(
    () => recipes.filter((r) => !r.worktreeId && !r.shadowedBy),
    [recipes]
  );

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
      baseBranchTouchedRef.current = true;
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
    const inUseSet = new Set(inUseBranches);
    return branches.filter((b) => !b.remote && !inUseSet.has(b.name));
  }, [branches, inUseBranches]);

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

  // --- Forge viewer identity ---
  // Probe the active forge's `identity` capability whenever the dialog opens
  // or the project root changes. The capability returns `null` (not throws)
  // for "no token / no viewer", so we treat that as the no-user state without
  // an assignmentError banner. An `isCurrent` ref guards against a stale
  // resolution setting state after `rootPath` switches mid-flight.
  useEffect(() => {
    if (!isOpen || !rootPath) return;
    let isCurrent = true;
    forgeClient
      .getCurrentUser(rootPath)
      .then((user) => {
        if (!isCurrent) return;
        setCurrentUser(user?.login);
        setCurrentUserAvatar(user?.avatarUrl);
      })
      .catch(() => {
        if (!isCurrent) return;
        setCurrentUser(undefined);
        setCurrentUserAvatar(undefined);
      });
    return () => {
      isCurrent = false;
    };
  }, [isOpen, rootPath]);

  // --- Bootstrap: load branches and reset top-level state on open ---
  useEffect(() => {
    if (!isOpen) return;

    // PR opens bypass the cache: PR-branch resolution may fetch from the
    // remote and must run against a fresh branch list.
    const cached = initialPR ? undefined : branchListCache.get(rootPath);

    setLoading(!cached);
    resetErrors();
    setPrBranchResolved(null);
    setBranches(cached ?? []);
    setBaseBranch("");
    setIsDismissing(false);
    setBranchMode("new");
    setSelectedExistingBranch(null);
    setExistingBranchQuery("");
    setWorktreeMode("local");
    isCreatingRef.current = false;
    baseBranchTouchedRef.current = false;
    // resetErrors() is NOT called here — touched refs are managed by individual hooks

    if (cached) {
      const seed = deriveDefaultBaseBranch(cached);
      setBaseBranch(seed.name);
      setFromRemote(seed.fromRemote);
    }

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

        branchListCache.set(rootPath, branchList);
        setBranches(branchList);

        if (initialPR?.headRef) {
          const remoteBranchName = `origin/${initialPR.headRef}`;
          const remoteBranch = branchList.find((b) => b.name === remoteBranchName);
          const localBranch = branchList.find((b) => b.name === initialPR.headRef && !b.remote);
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
              await worktreeClient.fetchPRBranch(rootPath, initialPR.number, initialPR.headRef);
              if (!isCurrent) return;
              const updatedBranches = await worktreeClient.listBranches(rootPath);
              if (!isCurrent) return;
              branchListCache.set(rootPath, updatedBranches);
              setBranches(updatedBranches);
              const fetchedLocal = updatedBranches.find(
                (b) => b.name === initialPR.headRef && !b.remote
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
        } else if (!baseBranchTouchedRef.current) {
          const next = deriveDefaultBaseBranch(branchList);
          setBaseBranch(next.name);
          setFromRemote(next.fromRemote);
        }
      })
      .catch((err) => {
        if (!isCurrent) return;
        if (cached) {
          logError("Failed to refresh branches", err);
          return;
        }
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
    const snapCurrentUserAvatar = currentUserAvatar;
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
          // #8888: when created from the PR dropdown, capture the source PR so
          // the host seeds the worktree's linked PR (and closing issue) eagerly
          // instead of waiting for branch-name polling to rediscover it.
          ...(snapInitialPR
            ? {
                sourcePrNumber: snapInitialPR.number,
                sourcePrTitle: snapInitialPR.title,
                sourcePrUrl: snapInitialPR.url,
                sourcePrState: normalizeSourcePrState(snapInitialPR.state),
                sourcePrLinkedIssueNumber: extractClosingIssueNumber(snapInitialPR.body),
              }
            : {}),
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

        // Skip when the selected issue already lists the current user as an
        // assignee: the assign call would be a no-op and the resulting Undo
        // would strip a pre-existing assignment this flow never created.
        if (
          !snapUseExisting &&
          snapIssue &&
          snapAssignToSelf &&
          snapCurrentUser &&
          !snapIssue.assignees.some((a) => a.login === snapCurrentUser)
        ) {
          try {
            await forgeClient.assignIssue(rootPath, snapIssue.number, snapCurrentUser);
            const assignIssueNumber = snapIssue.number;
            const assignUsername = snapCurrentUser;
            // Optimistically patch every cached issue-list slot so the open
            // issues dropdown reflects the assignment immediately instead of
            // waiting ~30s for the next SWR revalidate (#10529). Provider-
            // agnostic: only touches the renderer cache through the forge
            // abstraction. The forge refresh remains the correctness backstop.
            const patchAssigneeCache = (assigned: boolean): void => {
              mutateCacheEntries(rootPath, "issue", (entry) => {
                let changed = false;
                const items = entry.items.map((item) => {
                  // `assignees` exists only on Issue, so this `in` check narrows
                  // the Issue|PR union safely and skips any non-issue slot.
                  if (!("assignees" in item) || item.number !== assignIssueNumber) return item;
                  const hasUser = item.assignees.some((a) => a.login === assignUsername);
                  if (assigned) {
                    if (hasUser) return item;
                    changed = true;
                    return {
                      ...item,
                      assignees: [
                        ...item.assignees,
                        { login: assignUsername, avatarUrl: snapCurrentUserAvatar, rawData: null },
                      ],
                    };
                  }
                  if (!hasUser) return item;
                  changed = true;
                  return {
                    ...item,
                    assignees: item.assignees.filter((a) => a.login !== assignUsername),
                  };
                });
                return changed ? { ...entry, items } : null;
              });
            };
            // A cache-layer throw must not masquerade as an assignment failure:
            // the server-side assign already succeeded by this point.
            try {
              patchAssigneeCache(true);
            } catch (cacheErr) {
              logError("Failed to patch issue cache after self-assign", cacheErr);
            }
            const undoFiredRef = { current: false };
            const undoOnClick = (): void => {
              if (undoFiredRef.current) return;
              undoFiredRef.current = true;
              void forgeClient
                .unassignIssue(rootPath, assignIssueNumber, assignUsername)
                .then(() => {
                  patchAssigneeCache(false);
                })
                .catch((err: unknown) => {
                  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
                  notify({
                    type: "warning",
                    title: "Couldn't undo assignment",
                    message: `${formatErrorMessage(err, "Couldn't unassign issue")} — you can unassign manually on ${forgeName}`,
                  });
                });
            };
            notify({
              type: "success",
              title: "Issue assigned",
              message: `#${snapIssue.number} assigned to you`,
              correlationId: worktreeId,
              priority: "high",
              context: { eventKind: "uiFeedback" },
              action: {
                label: "Undo",
                onClick: undoOnClick,
              },
            });
          } catch (assignErr) {
            const message = formatErrorMessage(assignErr, "Couldn't assign issue");
            const issueUrl = snapIssue.url;
            notify({
              type: "warning",
              title: "Couldn't assign issue",
              message: `${message} — you can assign it manually on ${forgeName}`,
              actions: issueUrl
                ? [
                    {
                      label: "Open issue",
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
            const message = formatErrorMessage(cloneErr, "Couldn't clone layout");
            notify({
              type: "warning",
              title: "Couldn't clone layout",
              message: `${message} — the worktree itself was created`,
            });
          }
        } else if (snapSelectedRecipe) {
          try {
            const results = await runRecipeWithResults(
              snapSelectedRecipe.id,
              snapWorktreePath,
              worktreeId,
              {
                issueNumber: snapIssue?.number,
                prNumber: snapInitialPR?.number,
                worktreePath: snapWorktreePath,
                branchName: fullBranchName,
              }
            );
            notifyRecipeSpawnFailures(results, {
              recipeName: snapSelectedRecipe.name,
              projectId,
            });
          } catch (recipeErr) {
            const message = formatErrorMessage(recipeErr, "Couldn't run recipe");
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
              title: "Couldn't run recipe",
              message: `${message} — the worktree itself was created`,
              actions: [
                {
                  label: "Retry recipe",
                  onClick: () => {
                    runRecipeWithResults(recipeId, recipePath, recipeWorktreeId, recipeContext)
                      .then((results) =>
                        notifyRecipeSpawnFailures(results, {
                          recipeName: snapSelectedRecipe.name,
                          projectId,
                        })
                      )
                      .catch((err) => logError("Failed to run recipe", err));
                  },
                },
              ],
            });
          }
        }

        onWorktreeCreated?.(worktreeId);
        useAnnouncerStore.getState().announce(`Created worktree ${fullBranchName}`);
      } catch (err: unknown) {
        const message = formatErrorMessage(err, "Couldn't create worktree");
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
        useAnnouncerStore.getState().announce("Couldn't create worktree", "assertive");
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
    (issue: Issue | null) => {
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
                  onChange={(e) => {
                    baseBranchTouchedRef.current = true;
                    setFromRemote(e.target.checked);
                  }}
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
                  <span className="font-mono">{initialPR.headRef ?? "unknown"}</span> from the
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
