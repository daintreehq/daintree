import PQueue from "p-queue";
import type { BranchInfo, GitHubIssue, GitHubPR } from "@shared/types";

const PREQUERY_CONCURRENCY = 10;
const PREQUERY_TIMEOUT_MS = 5000;

export interface PlannedWorktree {
  item: GitHubIssue | GitHubPR;
  mode: "issue" | "pr";
  branchName: string;
  prefix?: string;
  skipped: boolean;
  skipReason?: string;
  headRefName?: string;
}

export interface PrequeryResult {
  branch: string;
  path: string;
}

export interface PrequeryOptions {
  rootPath: string;
  items: PlannedWorktree[];
  existingBranches: BranchInfo[] | null;
  getAvailableBranch: (rootPath: string, branchName: string) => Promise<string>;
  getDefaultPath: (rootPath: string, branchName: string) => Promise<string>;
  isStaleRun: () => boolean;
  onProgress?: (completed: number, total: number) => void;
}

export interface PrequeryOutput {
  results: Map<number, PrequeryResult>;
  failedItems: Array<{ number: number; error: Error }>;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
}

function applyUniqueSuffix(branch: string, assignedBranches: Set<string>): string {
  if (!assignedBranches.has(branch)) {
    assignedBranches.add(branch);
    return branch;
  }
  let n = 2;
  while (assignedBranches.has(`${branch}-${n}`)) n++;
  const uniqueBranch = `${branch}-${n}`;
  assignedBranches.add(uniqueBranch);
  return uniqueBranch;
}

function resolveBranchUniqueness(
  candidateBranches: Map<number, string>,
  inputOrder: number[]
): Map<number, string> {
  const assignedBranches = new Set<string>();
  const uniqueBranches = new Map<number, string>();

  for (const itemNumber of inputOrder) {
    const candidate = candidateBranches.get(itemNumber);
    if (candidate !== undefined) {
      uniqueBranches.set(itemNumber, applyUniqueSuffix(candidate, assignedBranches));
    }
  }

  return uniqueBranches;
}

async function resolveIssuePrequeries({
  rootPath,
  items,
  existingBranches: _existingBranches,
  getAvailableBranch,
  getDefaultPath,
  isStaleRun,
  onProgress,
}: PrequeryOptions): Promise<PrequeryOutput> {
  const issueItems = items.filter((p) => p.mode === "issue" && !p.skipped);
  const inputOrder = issueItems.map((p) => p.item.number);

  if (inputOrder.length === 0) {
    return { results: new Map(), failedItems: [] };
  }

  const results = new Map<number, PrequeryResult>();
  const branchQueue = new PQueue({ concurrency: PREQUERY_CONCURRENCY });
  const candidateBranches = new Map<number, string>();
  const branchErrors = new Array<{ number: number; error: Error }>();

  const branchPromises = issueItems.map((planned) =>
    branchQueue.add(async () => {
      if (isStaleRun()) return;
      try {
        const branch = await withTimeout(
          getAvailableBranch(rootPath, planned.branchName),
          PREQUERY_TIMEOUT_MS,
          `Prequery timeout for branch lookup on issue #${planned.item.number}`
        );
        candidateBranches.set(planned.item.number, branch);
      } catch (err) {
        branchErrors.push({
          number: planned.item.number,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })
  );

  await Promise.all(branchPromises);
  if (isStaleRun()) return { results, failedItems: branchErrors };

  const uniqueBranches = resolveBranchUniqueness(candidateBranches, inputOrder);

  const pathQueue = new PQueue({ concurrency: PREQUERY_CONCURRENCY });
  const pathErrors = new Array<{ number: number; error: Error }>();

  const failedNumbers = new Set(branchErrors.map((e) => e.number));

  const pathPromises = inputOrder
    .filter((n) => !failedNumbers.has(n) && uniqueBranches.has(n))
    .map((itemNumber) =>
      pathQueue.add(async () => {
        if (isStaleRun()) return;
        const branch = uniqueBranches.get(itemNumber)!;
        try {
          const path = await withTimeout(
            getDefaultPath(rootPath, branch),
            PREQUERY_TIMEOUT_MS,
            `Prequery timeout for path lookup on issue #${itemNumber}`
          );
          results.set(itemNumber, { branch, path });
        } catch (err) {
          pathErrors.push({
            number: itemNumber,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      })
    );

  await Promise.all(pathPromises);
  if (isStaleRun()) return { results, failedItems: [...branchErrors, ...pathErrors] };

  onProgress?.(results.size, inputOrder.length);

  return { results, failedItems: [...branchErrors, ...pathErrors] };
}

export { resolveIssuePrequeries };
