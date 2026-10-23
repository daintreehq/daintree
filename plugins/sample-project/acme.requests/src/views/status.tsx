import { Badge } from "@daintreehq/plugin-ui";
import type { ReactElement } from "react";
import type { RequestStatus } from "../contracts";

export const STATUS_LABELS: Record<RequestStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_TONES = { open: "info", in_progress: "warning", done: "success" } as const;

export function StatusBadge({ status }: { status: RequestStatus }): ReactElement {
  return (
    <Badge tone={STATUS_TONES[status]} size="xs">
      {STATUS_LABELS[status]}
    </Badge>
  );
}
