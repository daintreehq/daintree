import type { BranchInfo } from "@/types/electron";

export interface BranchOption {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
  labelText: string;
  searchText: string;
}

export function formatBranchLabel(branch: BranchInfo): string {
  const parts = [branch.name];
  if (branch.current) parts.push("(current)");
  if (branch.remote) parts.push("(remote)");
  return parts.join(" ");
}

export function toBranchOption(branch: BranchInfo): BranchOption {
  const labelText = formatBranchLabel(branch);
  return {
    name: branch.name,
    isCurrent: !!branch.current,
    isRemote: !!branch.remote,
    remoteName: branch.remote || null,
    labelText,
    searchText: labelText.toLowerCase(),
  };
}

export function filterBranches(
  branches: BranchOption[],
  query: string,
  limit: number = 200
): BranchOption[] {
  if (limit <= 0) {
    return [];
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return branches.slice(0, limit);
  }

  const lowerQuery = trimmedQuery.toLowerCase();
  const filtered: BranchOption[] = [];

  for (const branch of branches) {
    if (branch.searchText.includes(lowerQuery)) {
      filtered.push(branch);
      if (filtered.length >= limit) {
        break;
      }
    }
  }

  return filtered;
}
