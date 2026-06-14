import type { Issue, PR } from "@shared/types/forge";

/**
 * Host-owned contracts for forge-provider view slots (`ForgeProviderContribution.slots`).
 * A provider plugin contributing one of these views must conform to the
 * matching props shape — the plugin imports these types (host → plugin is the
 * allowed dependency direction), never the reverse. All resource shapes are
 * the normalized forge types; provider-specific data rides along in each
 * item's `rawData`.
 */

/** Contract for the `bulkCreateWorktreeDialog` slot. */
export interface ForgeBulkCreateWorktreeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "issue" | "pr";
  selectedIssues: Issue[];
  selectedPRs: PR[];
  onComplete: () => void;
}

/** Contract for the `issueSelector` slot. */
export interface ForgeIssueSelectorProps {
  projectPath: string;
  selectedIssue: Issue | null;
  onSelect: (issue: Issue | null) => void;
  disabled?: boolean;
}
