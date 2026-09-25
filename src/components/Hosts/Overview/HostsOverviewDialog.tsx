import { LayoutGrid } from "lucide-react";
import { LOCAL_HOST_ID, type HostId } from "@shared/types/remoteHosts";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { useProjectStore } from "@/store/projectStore";
import { PortsView } from "../PortsView";
import { useHostList } from "../hostList";
import { buildHostMenuRows, clientPlatform } from "../hostModel";
import { switchToHost } from "../hostSwitching";
import { HostCard } from "./HostCard";
import { HostFleetTargets } from "./HostFleetTargets";
import { isLive } from "./overviewModel";

const EMPTY_HISTORY: never[] = [];

/**
 * Where a host's plugin parity line goes once the plugin-parity summary is
 * available to embed. Renders nothing until then.
 */
function PluginParitySlot(_props: { hostId: HostId }) {
  return null;
}

interface HostsOverviewDialogProps {
  onClose: () => void;
}

/**
 * Every machine at a glance: one card per host with its recent load, what
 * its agents are observed doing, and who drives it. Clicking a card switches
 * this window to that host (Cmd/Ctrl-click opens a new window).
 */
export function HostsOverviewDialog({ onClose }: HostsOverviewDialogProps) {
  const hostList = useHostList();
  const history = useHostMetricsStore((state) => state.history);
  const openCloneRepoDialog = useProjectStore((state) => state.openCloneRepoDialog);
  const windowHostId = getViewHostId() ?? LOCAL_HOST_ID;
  const rows = buildHostMenuRows(hostList.hosts, {
    localPlatform: clientPlatform(),
    currentHostId: windowHostId,
    localSummary: history[LOCAL_HOST_ID]?.[0] ?? hostList.localSummary,
  });

  const switchTo = (hostId: HostId, isCurrent: boolean, newWindow: boolean) => {
    if (isCurrent && !newWindow) return;
    onClose();
    void switchToHost(hostId, newWindow);
  };

  const addProject = () => {
    onClose();
    openCloneRepoDialog();
  };

  return (
    <AppDialog isOpen onClose={onClose} size="5xl" initialFocus="none">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<LayoutGrid className="h-4 w-4 text-text-secondary" />}>
          Hosts overview
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.BodyScroll>
        <div className="flex flex-col gap-6">
          <div
            className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            data-testid="hosts-overview-grid"
          >
            {rows.map((row) => (
              <HostCard
                key={row.hostId}
                row={row}
                history={history[row.hostId] ?? EMPTY_HISTORY}
                onSwitch={(newWindow) => switchTo(row.hostId, row.isCurrent, newWindow)}
              >
                <PluginParitySlot hostId={row.hostId} />
                {row.isCurrent ? (
                  <div>
                    <Button variant="outline" size="sm" onClick={addProject}>
                      Add project…
                    </Button>
                  </div>
                ) : (
                  isLive(row) && <HostFleetTargets hostId={row.hostId} hostName={row.name} />
                )}
              </HostCard>
            ))}
          </div>
          <PortsView hostId={windowHostId === LOCAL_HOST_ID ? undefined : windowHostId} />
        </div>
      </AppDialog.BodyScroll>
    </AppDialog>
  );
}
