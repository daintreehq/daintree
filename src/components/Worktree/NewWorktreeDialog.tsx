import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  FolderOpen,
  GitBranch,
  Check,
  AlertCircle,
  Loader2,
  ChevronsUpDown,
  Search,
  UserPlus,
  Play,
  Info,
  ChevronDown,
} from "lucide-react";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { worktreeClient, githubClient, projectClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { IssueSelector } from "@/components/GitHub/IssueSelector";
import { generateBranchSlug } from "@/utils/textParsing";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { parseBranchInput, suggestPrefixes, detectPrefixFromIssue } from "./branchPrefixUtils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  toBranchOption,
  buildBranchRows,
  type BranchOption,
  type BranchPickerRow,
} from "./branchPickerUtils";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import type { WorktreeState } from "@shared/types";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useGitHubConfigStore } from "@/store/githubConfigStore";
import { notify } from "@/lib/notify";
import { systemClient } from "@/clients/systemClient";
import { useRecipeStore } from "@/store/recipeStore";
import { mapCreationError, type WorktreeCreationError } from "./worktreeCreationErrors";
import { useProjectStore } from "@/store/projectStore";
import type { ProjectSettings } from "@/types";

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
  const [creating, setCreating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<WorktreeCreationError | null>(null);
  const [isCheckingBranch, setIsCheckingBranch] = useState(false);
  const [isGeneratingPath, setIsGeneratingPath] = useState(false);

  const [baseBranch, setBaseBranch] = useState("");
  const [branchInput, setBranchInput] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [fromRemote, setFromRemote] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [branchWasAutoResolved, setBranchWasAutoResolved] = useState(false);
  const [pathWasAutoResolved, setPathWasAutoResolved] = useState(false);
  const [prBranchResolved, setPrBranchResolved] = useState<boolean | null>(null);

  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentBranchNames, setRecentBranchNames] = useState<string[]>([]);

  const [projectSettings, setProjectSettings] = useState<ProjectSettings | null>(null);
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null);
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const recipeSelectionTouchedRef = useRef(false);

  const [prefixPickerOpen, setPrefixPickerOpen] = useState(false);
  const [prefixSelectedIndex, setPrefixSelectedIndex] = useState(0);
  const branchInputTouchedRef = useRef(false);
  const [gitUsername, setGitUsername] = useState<string | null>(null);

  const [isDismissing, setIsDismissing] = useState(false);
  const keepEditingButtonRef = useRef<HTMLButtonElement>(null);
  const issueTouchedRef = useRef(false);
  const pathTouchedRef = useRef(false);

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
  const { recipes, runRecipe, loadRecipes } = useRecipeStore();
  const currentProject = useProjectStore((s) => s.currentProject);
  const projectId = currentProject?.id ?? "";
  const lastSelectedWorktreeRecipeId = lastSelectedWorktreeRecipeIdByProject[projectId];

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
    if (!isOpen) return;
    if (githubConfig?.hasToken && !githubConfig.username) {
      refreshGitHubConfig();
    }
  }, [isOpen, githubConfig?.hasToken, githubConfig?.username, refreshGitHubConfig]);

  useEffect(() => {
    if (isOpen && currentProject) {
      const requestedProjectId = currentProject.id;
      projectClient
        .getSettings(requestedProjectId)
        .then((settings) => {
          if (currentProject?.id === requestedProjectId) {
            setProjectSettings(settings);
            if (settings.branchPrefixMode === "username") {
              window.electron.git
                .getUsername(currentProject.path)
                .then((username) => {
                  if (!username) {
                    setGitUsername(null);
                    return;
                  }
                  // Slugify: lowercase, replace spaces and invalid branch chars with hyphens, collapse/trim
                  const slug = username
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/-+/g, "-")
                    .replace(/^-|-$/g, "");
                  setGitUsername(slug || null);
                })
                .catch(() => setGitUsername(null));
            }
          }
        })
        .catch((err) => console.error("Failed to load project settings:", err));

      if (recipes.length === 0 && currentProject?.id) {
        loadRecipes(currentProject.id).catch((err) =>
          console.error("Failed to load recipes:", err)
        );
      }
    }
  }, [isOpen, currentProject, recipes.length, loadRecipes]);

  useEffect(() => {
    if (!isOpen) return;
    if (!projectId) return;
    if (globalRecipes.length === 0) return;
    if (recipeSelectionTouchedRef.current) return;

    // Priority: 0) initialRecipeId from palette fallback, 1) Last selected recipe (including explicit "no recipe"), 2) Project default, 3) null
    // undefined = never set, null = explicit "no recipe", string = recipe ID
    if (initialRecipeId && globalRecipes.some((r) => r.id === initialRecipeId)) {
      setSelectedRecipeId(initialRecipeId);
    } else if (lastSelectedWorktreeRecipeId !== undefined) {
      // User has made a previous selection (either null for "no recipe" or a recipe ID)
      if (
        lastSelectedWorktreeRecipeId === null ||
        globalRecipes.some((r) => r.id === lastSelectedWorktreeRecipeId)
      ) {
        setSelectedRecipeId(lastSelectedWorktreeRecipeId);
      } else {
        // Previously selected recipe no longer exists - clear it and fall back to default
        if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
        if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
          setSelectedRecipeId(defaultRecipeId);
        }
      }
    } else if (defaultRecipeId && globalRecipes.some((r) => r.id === defaultRecipeId)) {
      // No previous selection - use project default
      setSelectedRecipeId(defaultRecipeId);
    }
  }, [
    isOpen,
    globalRecipes,
    lastSelectedWorktreeRecipeId,
    defaultRecipeId,
    projectId,
    initialRecipeId,
    setLastSelectedWorktreeRecipeIdByProject,
  ]);

  useEffect(() => {
    if (!selectedRecipeId) return;
    if (globalRecipes.some((recipe) => recipe.id === selectedRecipeId)) return;
    // Selected recipe no longer exists - clear both local and persisted state
    setSelectedRecipeId(null);
    if (projectId) setLastSelectedWorktreeRecipeIdByProject(projectId, undefined);
  }, [globalRecipes, selectedRecipeId, projectId, setLastSelectedWorktreeRecipeIdByProject]);

  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchListRef = useRef<HTMLDivElement>(null);
  const prefixListRef = useRef<HTMLDivElement>(null);

  const branchOptions = useMemo(() => branches.map(toBranchOption), [branches]);

  const worktreeByBranch = useMemo(() => {
    const map = new Map<string, WorktreeState>();
    const worktrees = useWorktreeDataStore.getState().getWorktreeList();
    for (const wt of worktrees) {
      if (wt.branch) map.set(wt.branch, wt);
    }
    return map;
  }, [branches]);

  const branchRows = useMemo(
    () =>
      buildBranchRows(branchOptions, {
        query: branchQuery,
        recentBranchNames,
        worktreeByBranch,
      }),
    [branchOptions, branchQuery, recentBranchNames, worktreeByBranch]
  );

  const selectableRows = useMemo(
    () => branchRows.filter((r): r is BranchPickerRow & { kind: "option" } => r.kind === "option"),
    [branchRows]
  );

  const selectedBranchOption = useMemo(
    () => branchOptions.find((b) => b.name === baseBranch),
    [branchOptions, baseBranch]
  );

  const parsedBranch = useMemo(() => parseBranchInput(branchInput), [branchInput]);

  const configuredBranchPrefix = useMemo(() => {
    if (!projectSettings) return "";
    const mode = projectSettings.branchPrefixMode ?? "none";
    if (mode === "none") return "";
    if (mode === "username") return gitUsername ? `${gitUsername}/` : "";
    if (mode === "custom") return projectSettings.branchPrefixCustom?.trim() ?? "";
    return "";
  }, [projectSettings, gitUsername]);

  const prefixSuggestions = useMemo(() => {
    // Only show suggestions if typing at the beginning (no slash yet or cursor at prefix)
    const slashIndex = branchInput.indexOf("/");
    if (slashIndex === -1) {
      // No slash yet - show prefix suggestions based on current input
      return suggestPrefixes(branchInput);
    }
    // Already has slash - don't show prefix suggestions
    return [];
  }, [branchInput]);

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
    setPrefixSelectedIndex(0);
  }, [prefixPickerOpen]);

  useEffect(() => {
    // Open prefix picker when typing if suggestions are available, no slash yet, and user has typed something
    const hasTyped = branchInput.trim().length > 0;
    const hasNoSlash = branchInput.indexOf("/") === -1;
    const hasSuggestions = prefixSuggestions.length > 0 && prefixSuggestions.length < 12; // Don't show all 12 for empty input
    const shouldShowPrefixPicker = hasTyped && hasNoSlash && hasSuggestions;
    setPrefixPickerOpen(shouldShowPrefixPicker);
  }, [prefixSuggestions, branchInput]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [branchQuery]);

  useEffect(() => {
    if (branchListRef.current && selectedIndex >= 0 && selectableRows.length > 0) {
      const el = branchListRef.current.querySelector(
        `[data-option-index="${selectedIndex}"]`
      ) as HTMLElement;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, selectableRows.length]);

  const handleBranchSelect = (option: BranchOption) => {
    setBaseBranch(option.name);
    setFromRemote(option.isRemote);
    setBranchPickerOpen(false);
  };

  const handleBranchKeyDown = (e: React.KeyboardEvent) => {
    if (selectableRows.length === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        setBranchPickerOpen(false);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % selectableRows.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + selectableRows.length) % selectableRows.length);
        break;
      case "Enter":
        e.preventDefault();
        if (selectableRows[selectedIndex]) {
          handleBranchSelect(selectableRows[selectedIndex]);
        }
        break;
      case "Escape":
        e.preventDefault();
        setBranchPickerOpen(false);
        break;
    }
  };

  const handlePrefixKeyDown = (e: React.KeyboardEvent) => {
    if (!prefixPickerOpen || prefixSuggestions.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setPrefixSelectedIndex((prev) => (prev + 1) % prefixSuggestions.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setPrefixSelectedIndex(
          (prev) => (prev - 1 + prefixSuggestions.length) % prefixSuggestions.length
        );
        break;
      case "Enter":
        e.preventDefault();
        if (prefixSuggestions[prefixSelectedIndex]) {
          handlePrefixSelect(prefixSuggestions[prefixSelectedIndex].type.prefix);
        }
        break;
      case "Tab":
        // Only capture Tab if user has typed something or navigated suggestions
        // This allows Tab to move focus when just opening the field
        if (branchInput.trim().length > 0 || prefixSelectedIndex !== 0) {
          e.preventDefault();
          if (prefixSuggestions[prefixSelectedIndex]) {
            handlePrefixSelect(prefixSuggestions[prefixSelectedIndex].type.prefix);
          }
        }
        break;
      case "Escape":
        e.preventDefault();
        setPrefixPickerOpen(false);
        break;
    }
  };

  const handlePrefixSelect = (prefix: string) => {
    const currentInput = branchInput.trim();
    const slashIndex = currentInput.indexOf("/");

    if (slashIndex === -1) {
      // No slash yet - replace entire input with prefix/
      setBranchInput(`${prefix}/`);
    } else {
      // Has slash - replace prefix part
      const slug = currentInput.slice(slashIndex + 1);
      setBranchInput(`${prefix}/${slug}`);
    }

    setPrefixPickerOpen(false);
    branchInputTouchedRef.current = true;

    // Keep focus on input
    setTimeout(() => newBranchInputRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setValidationError(null);
    setCreationError(null);
    setIsCheckingBranch(false);
    setIsGeneratingPath(false);
    setBranchWasAutoResolved(false);
    setPathWasAutoResolved(false);
    setPrBranchResolved(null);
    setBranches([]);
    setBaseBranch("");
    setFromRemote(false);
    setSelectedIssue(initialIssue ?? null);

    if (initialPR?.headRefName) {
      setBranchInput(initialPR.headRefName);
      branchInputTouchedRef.current = true;
    } else {
      setBranchInput("");
    }
    setWorktreePath("");
    setProjectSettings(null);
    setGitUsername(null);
    recipeSelectionTouchedRef.current = false;
    branchInputTouchedRef.current = false;
    issueTouchedRef.current = false;
    pathTouchedRef.current = false;
    setIsDismissing(false);
    setPrefixPickerOpen(false);
    setPrefixSelectedIndex(0);

    let isCurrent = true;

    worktreeClient.getRecentBranches(rootPath).then((recent) => {
      if (isCurrent) setRecentBranchNames(recent);
    }).catch(() => {
      if (isCurrent) setRecentBranchNames([]);
    });

    worktreeClient
      .listBranches(rootPath)
      .then((branchList) => {
        if (!isCurrent) return;

        setBranches(branchList);

        if (initialPR?.headRefName) {
          // For PR checkout, prefer the remote tracking branch origin/<headRefName>
          const remoteBranchName = `origin/${initialPR.headRefName}`;
          const remoteBranch = branchList.find((b) => b.name === remoteBranchName);
          const localBranch = branchList.find((b) => b.name === initialPR.headRefName && !b.remote);
          if (remoteBranch) {
            setBaseBranch(remoteBranchName);
            setFromRemote(true);
            setPrBranchResolved(true);
          } else if (localBranch) {
            // Branch exists locally — checkout existing branch
            setBaseBranch(localBranch.name);
            setFromRemote(false);
            setPrBranchResolved(true);
          } else {
            // Remote branch not yet fetched — block creation
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

          // Auto-set fromRemote based on the initial branch type
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
  }, [isOpen, rootPath, initialIssue, initialPR]);

  useEffect(() => {
    if (isOpen && !loading) {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [isOpen, loading]);

  useEffect(() => {
    if (!configuredBranchPrefix) return;
    if (branchInputTouchedRef.current) return;
    if (selectedIssue) return;
    if (branchInput === "" || branchInput === configuredBranchPrefix) {
      setBranchInput(configuredBranchPrefix);
    }
  }, [configuredBranchPrefix, selectedIssue, branchInput]);

  useEffect(() => {
    if (selectedIssue && !branchInputTouchedRef.current) {
      const slug = generateBranchSlug(selectedIssue.title, 30);
      const suggestedSlug = slug
        ? `issue-${selectedIssue.number}-${slug}`
        : `issue-${selectedIssue.number}`;

      const detectedPrefix = detectPrefixFromIssue(selectedIssue);
      const typePrefix = detectedPrefix || "feature";
      const baseName = `${typePrefix}/${suggestedSlug}`;

      setBranchInput(configuredBranchPrefix ? `${configuredBranchPrefix}${baseName}` : baseName);
    }
  }, [selectedIssue, configuredBranchPrefix]);

  // Auto-resolve branch name and path conflicts (debounced)
  useEffect(() => {
    const trimmedInput = branchInput.trim();

    // Validate input before calling IPC
    if (!trimmedInput || !rootPath) {
      setBranchWasAutoResolved(false);
      setPathWasAutoResolved(false);
      setIsCheckingBranch(false);
      setIsGeneratingPath(false);
      return;
    }

    // Parse the input to get full branch name
    const parsed = parseBranchInput(trimmedInput);
    const fullBranchName = parsed.fullBranchName;

    // Skip auto-resolve if slug is empty (e.g., "feature/")
    if (parsed.hasPrefix && (!parsed.slug || !parsed.slug.trim())) {
      setBranchWasAutoResolved(false);
      setPathWasAutoResolved(false);
      setIsCheckingBranch(false);
      setIsGeneratingPath(false);
      return;
    }

    // Check for invalid characters in the slug part
    if (parsed.hasPrefix) {
      if (/[\s.]$/.test(parsed.slug) || /^[.-]/.test(parsed.slug) || /[\\:]/.test(parsed.slug)) {
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
        return;
      }
    } else {
      if (
        /[\s.]$/.test(trimmedInput) ||
        /^[.-]/.test(trimmedInput) ||
        /[/\\:]/.test(trimmedInput)
      ) {
        setIsCheckingBranch(false);
        setIsGeneratingPath(false);
        return;
      }
    }

    setIsCheckingBranch(true);
    setIsGeneratingPath(true);

    const abortController = new AbortController();

    // Debounce to avoid IPC calls on every keystroke (300ms)
    const timeoutId = setTimeout(() => {
      // Fetch both the available branch name and path in parallel
      Promise.allSettled([
        worktreeClient.getAvailableBranch(rootPath, fullBranchName),
        worktreeClient.getDefaultPath(rootPath, fullBranchName),
      ]).then((results) => {
        if (abortController.signal.aborted) return;

        setIsCheckingBranch(false);
        setIsGeneratingPath(false);

        const branchResult = results[0];
        const pathResult = results[1];

        // Handle branch resolution
        if (branchResult.status === "fulfilled") {
          const availableBranch = branchResult.value;
          const branchResolved = availableBranch !== fullBranchName;
          setBranchWasAutoResolved(branchResolved);

          // If branch was auto-resolved, update the branch input
          if (branchResolved) {
            setBranchInput(availableBranch);
          }
        } else {
          console.error("Failed to get available branch:", branchResult.reason);
          setBranchWasAutoResolved(false);
        }

        // Handle path resolution
        if (pathResult.status === "fulfilled") {
          const suggestedPath = pathResult.value;
          const pathBaseName = suggestedPath.split(/[/\\]/).pop() || "";
          const branchSlug = fullBranchName.replace(/[^a-zA-Z0-9-_]/g, "-");
          const pathResolved = pathBaseName !== branchSlug && /-\d+$/.test(pathBaseName);
          setPathWasAutoResolved(pathResolved);
          setWorktreePath(suggestedPath);
        } else {
          console.error("Failed to get default path:", pathResult.reason);
          setPathWasAutoResolved(false);
          // Fallback path generation
          const sanitizedBranch = fullBranchName.replace(/[^a-zA-Z0-9-_]/g, "-");
          const separator = rootPath.includes("\\") ? "\\" : "/";
          const repoName = rootPath.split(/[/\\]/).pop() || "repo";
          setWorktreePath(
            `${rootPath}${separator}..${separator}${repoName}-worktrees${separator}${sanitizedBranch}`
          );
        }
      });
    }, 300);

    return () => {
      clearTimeout(timeoutId);
      abortController.abort();
      setIsCheckingBranch(false);
      setIsGeneratingPath(false);
    };
  }, [branchInput, rootPath]);

  const isFormDirty = useMemo(
    () => {
      if (branchInputTouchedRef.current && branchInput.trim()) return true;
      if (issueTouchedRef.current && selectedIssue !== null) return true;
      if (recipeSelectionTouchedRef.current) return true;
      if (pathTouchedRef.current && worktreePath.trim()) return true;
      return false;
    },
    // selectedIssue and selectedRecipeId are intentional triggers — the memo reads
    // touched refs that are set in the same handler as these state changes.
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

  const handleIssueSelect = useCallback((issue: GitHubIssue | null) => {
    setSelectedIssue(issue);
    if (issue !== null) issueTouchedRef.current = true;
  }, []);

  useEffect(() => {
    if (isDismissing) {
      requestAnimationFrame(() => keepEditingButtonRef.current?.focus());
    }
  }, [isDismissing]);

  const handleCreate = async () => {
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

    // Validate the prefix and slug parts
    if (parsed.hasPrefix) {
      // Require non-empty slug when prefix is present
      if (!parsed.slug || !parsed.slug.trim()) {
        setValidationError("Please enter a branch name after the prefix");
        return;
      }

      // Validate prefix component for invalid git ref characters
      if (
        /[\s.:]/.test(parsed.prefix) ||
        /^[.-]/.test(parsed.prefix) ||
        parsed.prefix.includes("..")
      ) {
        setValidationError("Branch prefix contains invalid characters");
        return;
      }

      // Validate slug part
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

    setCreating(true);
    setValidationError(null);
    setCreationError(null);

    try {
      // For PR checkout, detect if the branch already exists locally (use existing)
      // vs needs to be created from remote (fromRemote).
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

      // Assign issue to current user if enabled
      if (selectedIssue && assignWorktreeToSelf && currentUser) {
        try {
          await githubClient.assignIssue(rootPath, selectedIssue.number, currentUser);
          notify({
            type: "success",
            title: "Issue Assigned",
            message: `Issue #${selectedIssue.number} assigned to @${currentUser}`,
          });
        } catch (assignErr) {
          const message = assignErr instanceof Error ? assignErr.message : "Failed to assign issue";
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

      // Run selected recipe if one is chosen
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
    } finally {
      setCreating(false);
    }
  };

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={handleBeforeClose}
      size="md"
      dismissible={!creating}
      data-testid="new-worktree-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<GitBranch className="w-5 h-5 text-canopy-accent" />}>
          {initialPR ? "Checkout PR Branch" : "Create New Worktree"}
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
          <TooltipProvider>
            <div className="space-y-4">
              {initialPR ? (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] bg-canopy-accent/5 border border-canopy-accent/20 text-sm min-w-0">
                  <GitBranch className="w-4 h-4 text-canopy-accent shrink-0" aria-hidden="true" />
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
                          disabled={creating}
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
                    disabled={creating}
                  />
                </div>
              )}

              {/* Assignment control - only show when issue is selected and GitHub auth available */}
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
                        disabled={creating}
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
                      disabled={creating}
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
                                    <span className="text-xs text-canopy-warning" title={`In use by worktree: ${row.inUseWorktree.name}`}>
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
                          branchInputTouchedRef.current = true;
                          setValidationError(null);
                          setCreationError(null);
                        }}
                        onKeyDown={handlePrefixKeyDown}
                        placeholder="feature/add-user-auth"
                        className="w-full px-3 pr-10 py-2 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent font-mono text-sm"
                        disabled={creating}
                        aria-describedby={
                          branchWasAutoResolved ? "branch-resolved-hint" : undefined
                        }
                        role="combobox"
                        aria-autocomplete="list"
                        aria-controls="prefix-list"
                        aria-expanded={prefixPickerOpen}
                      />
                      {isCheckingBranch && (
                        <Loader2
                          className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-canopy-text/40 pointer-events-none"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[var(--radix-popover-trigger-width)] p-0 bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] shadow-lg"
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
                        disabled={creating}
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
                      disabled={creating}
                    />
                    {isGeneratingPath && (
                      <Loader2
                        className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-canopy-text/40 pointer-events-none"
                        aria-hidden="true"
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
                    disabled={creating}
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
                  disabled={creating}
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
                          disabled={creating}
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
                        disabled={creating}
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
                      <pre className="mt-1.5 overflow-x-auto rounded bg-status-error/5 p-2 font-mono text-[11px] text-canopy-text/50 whitespace-pre-wrap break-all">
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
            <Button variant="ghost" onClick={handleRequestClose} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                creating ||
                loading ||
                isCheckingBranch ||
                isGeneratingPath ||
                (initialPR !== null && initialPR !== undefined && prBranchResolved === false)
              }
              className="min-w-[100px]"
              data-testid="create-worktree-button"
            >
              {creating ? (
                <>
                  <Loader2 className="animate-spin" />
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
