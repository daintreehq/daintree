// `npm run db:freeze`: record every migration in the journal as shipped. Run on
// the release branch, so the ledger holds exactly what the release ships.
// `-- --check` writes nothing and fails while any migration is still unfrozen:
// the release runs it on the tree it is about to tag.
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
const check = process.argv.includes("--check");

try {
  const added = freezeMigrationLedger(path.join(persistenceDir, "migrations"), ledgerPath, {
    dryRun: check,
  });
  const tags = added.map((m) => m.tag).join(", ");
  if (added.length === 0) {
    console.log(check ? "Every migration is frozen." : "No new migrations to freeze.");
  } else if (check) {
    console.error(`Not frozen yet: ${tags}. Run npm run db:freeze and commit the ledger.`);
    process.exit(1);
  } else {
    console.log(`Froze ${tags} in ${path.relative(process.cwd(), ledgerPath)}.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
