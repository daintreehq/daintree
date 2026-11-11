import type { Project } from "../../../shared/types/project.js";
import type {
  ScheduledAssistantLaunchRequest,
  ScheduledAssistantLaunchResult,
} from "./ScheduledRunLauncher.js";

const NO_PROJECT = "The project couldn't be found.";
const LAUNCH_FAILED = "The Daintree Assistant couldn't start.";

/**
 * Starts the project's Daintree Assistant for a schedule's run (#16169), the
 * way an Assistant is started with no view: in a vacant session only, never
 * displacing one, and where it can, not where a stopped session keeps a
 * conversation; past its folder-trust question, with the run's prompt and
 * handback instruction in place of a greeting. The session records the run as
 * who started it, which is how the workers it launches are attributed to it.
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
  const { scheduleId, runId } = request.scheduledRun;
  const result = await startAssistantWithoutView(
    {
      projectId: project.id,
      startedBy: { kind: "schedule", scheduleId, runId },
      scheduled: {
        terminalId: request.terminalId,
        prompt: request.prompt,
        scheduledRun: request.scheduledRun,
      },
    },
    {
      ...deps,
      // A stopped session's conversation stays the person's to resume while
      // another session is free.
      keptSlots: (projectId) => helpSessionService.listPendingHibernationSlots(projectId),
    }
  );
  if (result.status === "started") return { status: "started" };
  if (result.reason === "no-slot") return { status: "no-session" };
  return { status: "failed", message: result.reason === "no-project" ? NO_PROJECT : LAUNCH_FAILED };
}
