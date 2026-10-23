import type { PanelViewProps } from "@daintreehq/plugin-sdk";
import { Callout, EmptyState, ListRow, PaneState } from "@daintreehq/plugin-ui";
import { useState, type ReactElement } from "react";
import { useRequests } from "./data";
import { StatusBadge } from "./status";

/**
 * The sidebar list. Selecting a request moves the shared navigation and
 * brings Home forward, where the request opens: the two views never talk to
 * each other, they both follow `navigation.location`.
 */
export default function Sidebar({ pluginId, navigation }: PanelViewProps): ReactElement {
  const requests = useRequests(pluginId);
  const [refused, setRefused] = useState(false);
  const location = navigation?.location;
  const selectedId = location?.sectionId === "request" ? String(location.params.requestId) : null;

  if (requests.error && !requests.data) {
    return (
      <PaneState
        kind="error"
        title="Couldn't open the requests"
        onRetry={() => void requests.revalidate()}
      />
    );
  }
  if (!requests.data) return <PaneState kind="loading" title="Opening requests" />;

  const open = (sectionId: "request" | "reports", requestId?: string) => {
    if (!navigation) return;
    const result = navigation.navigate(
      requestId ? { sectionId, params: { requestId } } : { sectionId }
    );
    setRefused(!result.ok && result.reason === "unsaved");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-1 p-2">
      {refused ? (
        <Callout severity="warning" size="compact">
          Save or discard the edit open in Request Desk first.
        </Callout>
      ) : null}
      <ListRow
        title="Reports"
        icon="file-text"
        selected={location?.sectionId === "reports"}
        onSelect={() => open("reports")}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {requests.data.length === 0 ? (
          <EmptyState scale="sidebar" title="No requests yet" />
        ) : (
          requests.data.map((request) => (
            <ListRow
              key={request.id}
              title={request.title}
              meta={<StatusBadge status={request.status} />}
              selected={request.id === selectedId}
              onSelect={() => open("request", request.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
