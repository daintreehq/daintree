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
} from "lucide-react";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue } from "@shared/types/github";
import { worktreeClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { IssueSelector } from "@/components/GitHub/IssueSelector";
import { generateBranchSlug } from "@/utils/textParsing";
import { BRANCH_TYPES } from "@shared/config/branchPrefixes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { toBranchOption, filterBranches, type BranchOption } from "./branchPickerUtils";

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

  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

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
    setBranches([]);
    setBaseBranch("");
    setFromRemote(false);
    setSelectedIssue(initialIssue ?? null);
    setNewBranch("");
    setWorktreePath("");
    setSelectedPrefix(BRANCH_TYPES[0].prefix);

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

  const handleCreate = async () => {
    if (!baseBranch) {
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

    try {
      const options: CreateWorktreeOptions = {
        baseBranch,
        newBranch: fullBranchName,
        path: worktreePath.trim(),
        fromRemote,
      };

      const result = await actionService.dispatch(
        "worktree.create",
        { rootPath, options },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }

      onWorktreeCreated?.();
      onClose();

      setNewBranch("");
      setWorktreePath("");
      setFromRemote(false);
      setSelectedPrefix(BRANCH_TYPES[0].prefix);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create worktree";
      setError(message);
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
                />
              </div>
              <p className="text-xs text-canopy-text/60">
                Full branch:{" "}
                <span className="font-mono text-canopy-accent">
                  {selectedPrefix}/{newBranch || "..."}
                </span>
              </p>
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

            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-[var(--radius-md)]">
                <AlertCircle className="w-4 h-4 text-[var(--color-status-error)] mt-0.5 flex-shrink-0" />
                <p className="text-sm text-[var(--color-status-error)]">{error}</p>
              </div>
            )}
          </div>
        )}
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose} disabled={creating}>
          Cancel
        </Button>
        <Button onClick={handleCreate} disabled={creating || loading} className="min-w-[100px]">
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
