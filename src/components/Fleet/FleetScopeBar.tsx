import { useCallback, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { Save, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFleetSavedScopesStore } from "@/store/fleetSavedScopesStore";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import type { FleetDeckScope } from "@/store/fleetDeckStore";
import { useProjectStore } from "@/store/projectStore";
import { collectEligibleIds } from "@/store/fleetArmingStore";

export function FleetScopeBar(): ReactElement | null {
  const { scopes } = useFleetSavedScopesStore(useShallow((s) => ({ scopes: s.scopes })));
  const saveScope = useFleetSavedScopesStore((s) => s.saveScope);
  const deleteScope = useFleetSavedScopesStore((s) => s.deleteScope);
  const armedIds = useFleetArmingStore((s) => s.armedIds);
  const armIds = useFleetArmingStore((s) => s.armIds);
  const projectId = useProjectStore((s) => s.currentProject?.id);

  const handleSave = useCallback(() => {
    if (!projectId || armedIds.size === 0) return;
    const name = prompt("Save scope as:");
    if (!name?.trim()) return;
    void saveScope(projectId, {
      name: name.trim(),
      terminalIds: Array.from(armedIds),
    });
  }, [projectId, armedIds, saveScope]);

  const handleRecall = useCallback(
    (scopeItem: (typeof scopes)[number]) => {
      if (scopeItem.terminalIds && scopeItem.terminalIds.length > 0) {
        armIds(scopeItem.terminalIds);
        return;
      }
      if (scopeItem.filter) {
        const ids = collectEligibleIds(scopeItem.filter.scope as FleetDeckScope, null);
        armIds(ids);
      }
    },
    [armIds]
  );

  const handleDelete = useCallback(
    (scopeId: string) => {
      if (!projectId) return;
      void deleteScope(projectId, scopeId);
    },
    [projectId, deleteScope]
  );

  const canSave = armedIds.size > 0 && !!projectId;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="fleet-scope-bar">
      {scopes.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => handleRecall(s)}
          onContextMenu={(e) => {
            e.preventDefault();
            handleDelete(s.id);
          }}
          className={cn(
            "group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-colors",
            "bg-daintree-accent/15 text-daintree-accent hover:bg-daintree-accent/25"
          )}
          data-testid={`fleet-scope-${s.id}`}
          title={`${s.name} (right-click to delete)`}
        >
          <span>{s.name}</span>
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(s.id);
            }}
            className="opacity-0 group-hover:opacity-60 hover:!opacity-100"
          >
            <Trash2 className="h-2.5 w-2.5" />
          </span>
        </button>
      ))}
      {canSave && (
        <button
          type="button"
          onClick={handleSave}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] transition-colors",
            "text-daintree-text/50 hover:text-daintree-text hover:bg-tint/[0.08]"
          )}
          data-testid="fleet-scope-save"
          title="Save current arming as scope (Cmd+S)"
        >
          <Save className="h-2.5 w-2.5" />
          Save
        </button>
      )}
    </div>
  );
}
