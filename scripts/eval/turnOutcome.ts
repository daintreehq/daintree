import { runJudge } from "./turnOutcomeJudge.js";
import { runTurnOutcomeEval } from "./turnOutcomeRun.js";

runTurnOutcomeEval(process.argv.slice(2), { judge: runJudge }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  }
);
