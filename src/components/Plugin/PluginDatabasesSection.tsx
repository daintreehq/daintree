import type { PluginDatabaseContribution } from "@shared/types/plugin";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";

/**
 * The SQLite files a plugin declares. Named in full because a project database
 * is a file in the user's repository that agents and git both see, and the
 * user should be able to find it without reading the manifest.
 *
 * An installed plugin's local database is one file every project shares, so
 * it says so; a project plugin's local data belongs to that project's copy.
 */
export function PluginDatabasesSection({
  databases,
  origin,
}: {
  databases: readonly PluginDatabaseContribution[];
  origin: "global" | "project";
}) {
  return (
    <div className="space-y-2">
      <h4 className={SECTION_LABEL_CLASS}>Databases</h4>
      <ul className="space-y-2">
        {databases.map((database) => (
          <li key={database.id} className="text-xs">
            <div className="text-text-primary">{database.description ?? database.id}</div>
            <div className="text-2xs text-text-secondary mt-0.5 break-all">
              {database.location === "local" ? (
                origin === "global" ? (
                  "Stored on this machine and shared by every project"
                ) : (
                  "Stored on this machine, outside the project"
                )
              ) : (
                <>
                  In the project at{" "}
                  <span className="font-mono select-text">
                    {database.path ?? `.daintree/data/…/${database.id}.db`}
                  </span>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
