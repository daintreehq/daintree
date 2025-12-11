import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/AppDialog";
import { FolderOpen, GitBranch, Check, AlertCircle, Loader2, ChevronDown } from "lucide-react";
import type { BranchInfo, CreateWorktreeOptions } from "@/types/electron";
import type { GitHubIssue } from "@shared/types/github";
import { worktreeClient } from "@/clients";
import { IssueSelector } from "@/components/GitHub/IssueSelector";
import { generateBranchSlug } from "@/utils/textParsing";
import { BRANCH_TYPES } from "@shared/config/branchPrefixes";

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

  const newBranchInputRef = useRef<HTMLInputElement>(null);

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

      await worktreeClient.create(options, rootPath);

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
              <select
                id="base-branch"
                value={baseBranch}
                onChange={(e) => {
                  const val = e.target.value;
                  setBaseBranch(val);
                  // Auto-update checkbox: if branch is remote, check it; else uncheck it
                  const branchInfo = branches.find((b) => b.name === val);
                  setFromRemote(!!branchInfo?.remote);
                }}
                className="w-full px-3 py-2 bg-canopy-bg border border-canopy-border rounded-md text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
                disabled={creating}
              >
                {branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                    {branch.current ? " (current)" : ""}
                    {branch.remote ? " (remote)" : ""}
                  </option>
                ))}
              </select>
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
                    className="appearance-none h-full px-3 py-2 bg-canopy-bg border border-canopy-border rounded-md text-canopy-text text-sm focus:outline-none focus:ring-2 focus:ring-canopy-accent pr-8"
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
                  className="flex-1 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-md text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
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
                  className="flex-1 px-3 py-2 bg-canopy-bg border border-canopy-border rounded-md text-canopy-text focus:outline-none focus:ring-2 focus:ring-canopy-accent"
                  disabled={creating}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      const selected = await window.electron.project.openDialog();
                      if (selected) {
                        setWorktreePath(selected);
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
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-md">
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
