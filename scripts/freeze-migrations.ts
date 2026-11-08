// `npm run db:freeze`: record every migration in the journal as shipped. Run on
// the release branch, so the ledger holds exactly what the release ships.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freezeMigrationLedger } from "../electron/services/persistence/migrationLedger.js";

const persistenceDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
  "services",
  "persistence"
);
const ledgerPath = path.join(persistenceDir, "frozen-migrations.json");

try {
  const added = freezeMigrationLedger(path.join(persistenceDir, "migrations"), ledgerPath);
  if (added.length === 0) {
    console.log("No new migrations to freeze.");
  } else {
    console.log(
      `Froze ${added.map((m) => m.tag).join(", ")} in ${path.relative(process.cwd(), ledgerPath)}.`
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
