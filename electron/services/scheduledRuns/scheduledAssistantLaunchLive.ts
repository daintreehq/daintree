import type { Project } from "../../../shared/types/project.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import type {
  ScheduledAssistantLaunchRequest,
  ScheduledAssistantLaunchResult,
} from "./ScheduledRunLauncher.js";

const REFUSALS: Record<"no-project" | "launch-failed", string> = {
  "no-project": "The project couldn't be found.",
  "launch-failed": "The Daintree Assistant couldn't start.",
};

/**
 * Starts the project's Daintree Assistant for a schedule's run (#16169), the
 * way an Assistant is started with no view: in the lowest vacant session
 * only, never displacing one or a stopped session's kept conversation, past
 * its folder-trust question, with the run's prompt and handback instruction
 * in place of a greeting. The session records the run as who started it,
 * which is how the workers it launches are attributed to the run.
 */
export async function launchScheduledAssistantLive(
  project: Project,
  request: ScheduledAssistantLaunchRequest
): Promise<ScheduledAssistantLaunchResult> {
  const [{ startAssistantWithoutView, liveAssistantLaunchDeps }, { helpSessionService }] =
    await Promise.all([
      import("../assistants/assistantLaunch.js"),
      import("../HelpSessionService.js"),
    ]);
  const deps = await liveAssistantLaunchDeps();
  const handbackCode = mintHandbackCode();
  const { scheduleId, runId } = request.scheduledRun;
  const result = await startAssistantWithoutView(
    {
      projectId: project.id,
      startedBy: { kind: "schedule", scheduleId, runId },
      scheduled: {
        terminalId: request.terminalId,
        prompt: appendHandbackInstruction(request.prompt, handbackCode, "run"),
        scheduledRun: request.scheduledRun,
        handbackCode,
      },
    },
    {
      ...deps,
      // A session that's stopped but keeps its conversation for the person
      // to resume is theirs too: a run never starts in its place.
      occupiedSlots: (projectId) => [
        ...deps.occupiedSlots(projectId),
        ...helpSessionService.listPendingHibernationSlots(projectId),
      ],
    }
  );
  if (result.status === "started") return { status: "started" };
  if (result.reason === "no-slot") return { status: "no-session" };
  return { status: "failed", message: REFUSALS[result.reason] };
}
