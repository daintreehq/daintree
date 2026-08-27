import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderGit2, Check, AlertCircle, GitBranch } from "lucide-react";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { Issue, PR } from "@shared/types/forge";

import { worktreeClient, forgeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { usePreferencesStore } from "@/store/preferencesStore";
import { notify } from "@/lib/notify";
import { patchIssueAssigneeCache } from "@/lib/forgeResourceCache";
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
import type { BranchOption, BranchWorktreeRef } from "./branchPickerUtils";
import { usePrefixPicker } from "./hooks/usePrefixPicker";
import {
  useRecipePicker,
  resolveEligibleDefaultRecipeId,
  CLONE_LAYOUT_ID,
} from "./hooks/useRecipePicker";
import { useWorktreeFormErrors } from "./hooks/useWorktreeFormErrors";
import { useWorktreeFormValidation } from "./hooks/useWorktreeFormValidation";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { spawnPanelsFromRecipe } from "./panelSpawning";

import {
  PrHeader,
  IssueLinkerView,
  AssignIssueToggle,
  BranchModeControl,
  BranchSummary,
  BaseBranchCombobox,
  ExistingBranchPicker,
  NewBranchInput,
  WorktreePathPicker,
  EnvironmentRadioGroup,
  RecipePickerPopover,
  FormGrid,
  FormSection,
  FormRow,
  HINT_CELL,
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
  const [recentBranchNames, setRecentBranchNames] = useState<string[]>([]);
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
  // Flattened to `[branch, id, name] x N` so the selector stays shallow-comparable
  // while still carrying the owning worktree's identity. One source for both the
  // base picker's "in use" badge and the existing picker's exclusion rule.
  const worktreeBranchEntries = useWorktreeStore(
    useShallow((s) => {
      const entries: string[] = [];
      for (const wt of s.worktrees.values()) {
        if (wt.branch) entries.push(wt.branch, wt.id, wt.name);
      }
      return entries;
    })
  );

  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, BranchWorktreeRef>();
    for (let i = 0; i < worktreeBranchEntries.length; i += 3) {
      map.set(worktreeBranchEntries[i]!, {
        id: worktreeBranchEntries[i + 1]!,
        name: worktreeBranchEntries[i + 2]!,
      });
    }
    return map;
  }, [worktreeBranchEntries]);
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

  const persistedDefaultRecipeId = projectSettings?.defaultWorktreeRecipeId;
  // Shadowed recipes stay listed (dimmed, marked "Overridden") instead of being
  // hidden — hiding an executable target is the silent failure #11510 is about.
  const startingLayoutRecipes = useMemo(() => recipes.filter((r) => !r.worktreeId), [recipes]);
  const defaultRecipeId = useMemo(
    () => resolveEligibleDefaultRecipeId(startingLayoutRecipes, persistedDefaultRecipeId),
    [startingLayoutRecipes, persistedDefaultRecipeId]
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

  const isExistingMode = branchMode === "existing" && !initialPR;

  const {
    isCheckingBranch,
    isGeneratingPath,
    worktreePath,
    setWorktreePath,
    branchWasAutoResolved,
    pathWasAutoResolved,
    pathTouchedRef,
    consumeBranchResolution,
  } = useBranchValidation({
    branchInput,
    rootPath,
    isOpen,
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

  const handleBaseBranchSelect = useCallback(
    (option: BranchOption) => {
      onSelectBranch(option.name, option.isRemote);
    },
    [onSelectBranch]
  );

  const baseBranchPicker = useBranchPicker({
    branches,
    selectedBranch: baseBranch,
    recentBranchNames,
    worktreeByBranch,
    onSelect: handleBaseBranchSelect,
  });

  // Only branches you could actually check out here: local, and not already held
  // by another worktree.
  const existingBranchCandidates = useMemo(
    () => branches.filter((b) => !b.remote && !worktreeByBranch.has(b.name)),
    [branches, worktreeByBranch]
  );

  const handleExistingBranchSelect = useCallback(
    (option: BranchOption) => {
      setSelectedExistingBranch(option.name);
      clearErrors();
    },
    [clearErrors]
  );

  const existingBranchPicker = useBranchPicker({
    branches: existingBranchCandidates,
    selectedBranch: selectedExistingBranch,
    recentBranchNames,
    worktreeByBranch,
    onSelect: handleExistingBranchSelect,
  });

  // Closing subsumes clearing the query and cursor, so this is the whole reset —
  // and it also guarantees neither picker can survive a mode switch or a dialog
  // reopen still expanded.
  const closeBaseBranchPicker = baseBranchPicker.setOpen;
  const closeExistingBranchPicker = existingBranchPicker.setOpen;

  const handleBranchModeChange = useCallback(
    (mode: BranchMode) => {
      setBranchMode(mode);
      setSelectedExistingBranch(null);
      closeExistingBranchPicker(false);
      clearErrors();
    },
    [clearErrors, closeExistingBranchPicker]
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
    setPrefixSelectedIndex,
    prefixSuggestions,
    prefixListRef,
    handlePrefixKeyDown,
    handlePrefixSelect,
    handleInputFocus: handleBranchInputFocus,
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
    startingLayoutRecipes,
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
    closeBaseBranchPicker(false);
    closeExistingBranchPicker(false);
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
          // Any remote may carry the PR head — on a fork layout the forge is
          // `upstream`, not `origin` (#11747). Matched as an exact
          // `<remote>/<headRef>` rather than a suffix, so a head named `x`
          // can't match `origin/feature/x`.
          const remoteCandidates = branchList.filter(
            (b) => b.remote && b.name === `${b.remote}/${initialPR.headRef}`
          );
          // A branch name is not a PR identity. When two remotes both carry the
          // name they may be different commits, and this component has no way
          // to tell which repo the PR belongs to — picking either could build
          // the worktree from the wrong commit. Fall through to the PR-number
          // fetch, which is authoritative. One match is unambiguous enough to
          // keep the fast path (and is the single-remote case).
          const remoteBranch = remoteCandidates.length === 1 ? remoteCandidates[0] : undefined;
          const localBranch = branchList.find((b) => b.name === initialPR.headRef && !b.remote);
          if (remoteBranch) {
            setBaseBranch(remoteBranch.name);
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
    setValidationError,
    clearErrors,
    closeBaseBranchPicker,
    closeExistingBranchPicker,
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

    // Submitting is an acceptance point for a pending auto-increment the user
    // never blurred into the field, so the placeholder, dispatch, recipe and
    // toast all name the branch the host will actually create.
    const resolvedBranchName = isExistingMode ? null : consumeBranchResolution(branchInput);
    const fullBranchName = isExistingMode
      ? selectedExistingBranch!
      : (resolvedBranchName ?? result.fullBranchName!);

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
        // Compared case-insensitively — forge logins are, so an "Ada" row would
        // otherwise slip past this guard and hand the user an Undo that removes
        // an assignment they already had.
        const alreadyAssignedToViewer =
          snapCurrentUser != null &&
          snapIssue?.assignees.some(
            (a) => a.login.trim().toLowerCase() === snapCurrentUser.trim().toLowerCase()
          );
        if (
          !snapUseExisting &&
          snapIssue &&
          snapAssignToSelf &&
          snapCurrentUser &&
          !alreadyAssignedToViewer
        ) {
          try {
            await forgeClient.assignIssue(rootPath, snapIssue.number, snapCurrentUser);
            const assignIssueNumber = snapIssue.number;
            const assignUsername = snapCurrentUser;
            // Optimistically patch every cached issue-list slot so the open
            // issues dropdown reflects the assignment immediately instead of
            // waiting out the renderer TTL (#10529). Provider-agnostic: only
            // touches the renderer cache through the forge abstraction. The
            // forge refresh remains the correctness backstop.
            const patchAssigneeCache = (assigned: boolean): void => {
              patchIssueAssigneeCache(
                rootPath,
                assignIssueNumber,
                { login: assignUsername, avatarUrl: snapCurrentUserAvatar },
                assigned
              );
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
                  // Same isolation as the forward patch — the unassign already
                  // succeeded, so a cache throw must not report a failed undo.
                  try {
                    patchAssigneeCache(false);
                  } catch (cacheErr) {
                    logError("Failed to patch issue cache after undo", cacheErr);
                  }
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
              // Auto-dismiss after a short window instead of staying sticky:
              // notify() defaults action-bearing toasts to duration 0, but the
              // Undo here is an optional, time-limited affordance — not a reason
              // to keep the confirmation on screen until manually dismissed.
              duration: 5_000,
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

  const handleBranchInputBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      const resolved = consumeBranchResolution(event.currentTarget.value);
      if (resolved) setBranchInput(resolved);
    },
    [consumeBranchResolution, setBranchInput]
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

  const submitDisabled =
    loading ||
    isCheckingBranch ||
    isGeneratingPath ||
    (isExistingMode && !selectedExistingBranch) ||
    (initialPR !== null && initialPR !== undefined && prBranchResolved === false);

  // Cmd/Ctrl+Enter submits from anywhere in the dialog. Advertised on the
  // primary button, so it has to actually work from the pickers too — a hint
  // for a shortcut that only fires in one field is worse than no hint.
  //
  // `handleCreate` is not memoised and changes identity every render, so it is
  // held in a ref: depending on it directly would tear down and re-add the
  // window listener on every keystroke in the form.
  const submitRef = useRef({ handleCreate, submitDisabled });
  useEffect(() => {
    submitRef.current = { handleCreate, submitDisabled };
  });

  useEffect(() => {
    if (!isOpen || isDismissing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      const { handleCreate: create, submitDisabled: blocked } = submitRef.current;
      if (blocked || isCreatingRef.current) return;
      e.preventDefault();
      void create();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, isDismissing]);

  // What the form is actually about to do, said once. Replaces the mono echo
  // line that used to sit under the branch input restating its own value.
  const outcomeSummary = isExistingMode ? (
    selectedExistingBranch ? (
      <BranchSummary
        branch={selectedExistingBranch}
        icon={<GitBranch className="w-3 h-3 shrink-0" aria-hidden="true" />}
      />
    ) : (
      <span className="truncate">Pick a branch to continue</span>
    )
  ) : parsedBranch.fullBranchName && baseBranch ? (
    <BranchSummary base={baseBranch} branch={parsedBranch.fullBranchName} />
  ) : (
    // Submit stays enabled on purpose — clicking it names what is missing,
    // which beats a disabled button that explains nothing. This is what keeps
    // the not-yet-ready state from looking identical to the ready one.
    <span className="truncate">
      {parsedBranch.fullBranchName
        ? "Pick a base branch to continue"
        : "Name the branch to continue"}
    </span>
  );

  const showIssueRow = !initialPR && !!forgeEntry?.contribution.slots?.issueSelector;
  const showRecipeRow = startingLayoutRecipes.length > 0;
  const hasSetupSection = showIssueRow || hasAnyEnvironments || showRecipeRow;

  // Same flags the real sections are built from, so the skeleton is the shape
  // that is actually about to render rather than a generic three-block guess.
  // Rows are modelled individually because a `hint` occupies its own grid row —
  // counting only label/control pairs made Name jump down on resolve.
  const skeletonSections: { title: string; rows: ("field" | "hint")[] }[] = [
    {
      title: "Branch",
      rows: isExistingMode ? ["field"] : ["field", "hint", "field"],
    },
    { title: "Destination", rows: ["field"] },
    ...(hasSetupSection
      ? [
          {
            title: "Setup",
            rows: Array<"field">(
              Number(showIssueRow) + Number(hasAnyEnvironments) + Number(showRecipeRow)
            ).fill("field"),
          },
        ]
      : []),
  ];

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={handleBeforeClose}
      size="lg"
      data-testid="new-worktree-dialog"
    >
      <AppDialog.Header className="py-3">
        {/* Neutral, not accent: the header glyph is decoration, and the primary
            action is this region's one load-bearing signal. */}
        <AppDialog.Title icon={<FolderGit2 className="w-4 h-4 text-text-secondary" />}>
          {initialPR ? "Check out PR branch" : "Create worktree"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body className="space-y-5">
        {initialPR && <PrHeader pr={initialPR} />}
        {loading ? (
          <Skeleton label="Loading branches">
            {/* Built from the same flags as the resolved form and rendered in
                the same FormGrid, so the branch list resolving swaps content in
                without moving anything. A fixed-shape skeleton would guess the
                section list wrong whenever Setup is empty or carries extra rows. */}
            <FormGrid>
              {skeletonSections.map((section) => (
                <FormSection key={section.title} title={section.title}>
                  {section.rows.map((row, index) =>
                    row === "hint" ? (
                      // h-4, not h-3: the resolved hint row is as tall as its 16px
                      // checkbox, and 12px here grew the row by 4px on resolve.
                      <SkeletonBone key={index} className={cn(HINT_CELL, "h-4 w-44")} />
                    ) : (
                      <Fragment key={index}>
                        <SkeletonBone className="h-3 w-12" />
                        <SkeletonBone className="h-8 w-full" />
                      </Fragment>
                    )
                  )}
                </FormSection>
              ))}
            </FormGrid>
          </Skeleton>
        ) : (
          <>
            <FormGrid>
              <FormSection
                title="Branch"
                action={
                  !initialPR && (
                    <BranchModeControl branchMode={branchMode} onChange={handleBranchModeChange} />
                  )
                }
              >
                {!isExistingMode && (
                  <FormRow
                    label="Base"
                    htmlFor="base-branch"
                    hint={
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
                        <span className="relative inline-flex shrink-0">
                          <input
                            id="from-remote"
                            type="checkbox"
                            checked={fromRemote}
                            onChange={(e) => {
                              baseBranchTouchedRef.current = true;
                              setFromRemote(e.target.checked);
                            }}
                            className={cn(
                              // A 16px box at the theme radius reads as a radio, not a checkbox.
                              "h-4 w-4 appearance-none rounded-[4px] border",
                              "transition-colors duration-150 ease-out",
                              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2",
                              fromRemote
                                ? "border-text-primary bg-text-primary"
                                : "border-border-strong bg-surface-input"
                            )}
                          />
                          {fromRemote && (
                            <Check
                              className="pointer-events-none absolute inset-0 m-auto h-3 w-3 text-text-inverse"
                              strokeWidth={3.5}
                              aria-hidden="true"
                            />
                          )}
                        </span>
                        Create from remote branch
                      </label>
                    }
                  >
                    <BaseBranchCombobox
                      baseBranch={baseBranch}
                      controller={baseBranchPicker}
                      errorField={errors.errorField}
                    />
                  </FormRow>
                )}

                {isExistingMode ? (
                  <FormRow label="Branch" htmlFor="existing-branch">
                    <ExistingBranchPicker
                      selectedBranch={selectedExistingBranch}
                      controller={existingBranchPicker}
                    />
                  </FormRow>
                ) : (
                  <FormRow label="Name" htmlFor="new-branch">
                    <NewBranchInput
                      value={branchInput}
                      onChange={handleBranchInputChange}
                      onBlur={handleBranchInputBlur}
                      isCheckingBranch={isCheckingBranch}
                      errorField={errors.errorField}
                      branchWasAutoResolved={branchWasAutoResolved}
                      prefixPickerOpen={prefixPickerOpen}
                      onPrefixPickerOpenChange={setPrefixPickerOpen}
                      prefixSuggestions={prefixSuggestions}
                      prefixSelectedIndex={prefixSelectedIndex}
                      onPrefixKeyDown={handlePrefixKeyDown}
                      onPrefixSelect={handlePrefixSelectWrap}
                      onPrefixCursorChange={setPrefixSelectedIndex}
                      onPrefixInputFocus={handleBranchInputFocus}
                      prefixListRef={prefixListRef}
                      inputRef={newBranchInputRef}
                    />
                  </FormRow>
                )}
              </FormSection>

              <FormSection title="Destination">
                <FormRow label="Path" htmlFor="worktree-path">
                  <WorktreePathPicker
                    value={worktreePath}
                    onChange={handleWorktreePathChange}
                    isGeneratingPath={isGeneratingPath}
                    errorField={errors.errorField}
                    pathWasAutoResolved={pathWasAutoResolved}
                    onBrowseClick={handleBrowseClick}
                  />
                </FormRow>
              </FormSection>

              {hasSetupSection && (
                <FormSection title="Setup">
                  {showIssueRow && (
                    <FormRow
                      label="Issue"
                      hint={
                        canAssignIssue && (
                          <AssignIssueToggle
                            assignWorktreeToSelf={assignWorktreeToSelf}
                            onSetAssignWorktreeToSelf={setAssignWorktreeToSelf}
                            currentUser={currentUser}
                            currentUserAvatar={currentUserAvatar}
                          />
                        )
                      }
                    >
                      <IssueLinkerView
                        projectPath={rootPath}
                        selectedIssue={selectedIssue}
                        onSelectIssue={handleIssueSelectWrapper}
                      />
                    </FormRow>
                  )}

                  {hasAnyEnvironments && (
                    <FormRow label="Environment" selfLabelled>
                      <EnvironmentRadioGroup
                        worktreeMode={worktreeMode}
                        onChange={setWorktreeMode}
                        resourceEnvironments={resourceEnvironments}
                        hasAnyEnvironments={hasAnyEnvironments}
                      />
                    </FormRow>
                  )}

                  {showRecipeRow && (
                    <FormRow label="Recipe" htmlFor="recipe-selector-trigger">
                      <RecipePickerPopover
                        recipes={startingLayoutRecipes}
                        selectedRecipeId={selectedRecipeId}
                        selectedRecipe={selectedRecipe}
                        defaultRecipeId={defaultRecipeId}
                        open={recipePickerOpen}
                        onOpenChange={setRecipePickerOpen}
                        onSelectRecipe={handleRecipeSelect}
                        onMarkTouched={() => {
                          markTouched("recipe");
                        }}
                        listId="recipe-selector"
                      />
                    </FormRow>
                  )}
                </FormSection>
              )}
            </FormGrid>

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
          </>
        )}
      </AppDialog.Body>

      <AppDialog.Footer hint={isDismissing ? undefined : outcomeSummary}>
        {isDismissing ? (
          <>
            <span role="alert" className="flex-1 text-sm text-text-secondary">
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
          <div className="flex items-center gap-3 shrink-0">
            <Button variant="ghost" size="sm" onClick={handleRequestClose}>
              Cancel
            </Button>
            <Button
              variant="contrast"
              size="sm"
              onClick={handleCreate}
              disabled={submitDisabled}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              data-testid="create-worktree-button"
            >
              {initialPR ? "Check out" : "Create worktree"}
              <span
                className="ml-1 rounded-xs bg-text-inverse/15 px-1 py-0.5 font-mono text-3xs leading-none text-text-inverse"
                aria-hidden="true"
              >
                {isMac() ? "\u2318\u21A9" : "Ctrl\u21A9"}
              </span>
            </Button>
          </div>
        )}
      </AppDialog.Footer>
    </AppDialog>
  );
}
