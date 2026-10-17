import type { FeatureSummary, PlanPayload, Run } from "./types";

/**
 * The project's plan, as the harness reports it (plan / features / done events).
 * The newest plan event wins; newer features events update its pass marks.
 */
export interface ProjectPlan extends PlanPayload {
  /** The run that produced the plan. */
  runId: string;
  /** Planner asked questions instead of planning. */
  asking: boolean;
  /** A build run started after this plan. */
  approved: boolean;
  /** The planner run finished and the plan waits for the user. */
  awaiting: boolean;
}

export function planOf(runs: Run[]): ProjectPlan | undefined {
  let plan: ProjectPlan | undefined;
  let features: FeatureSummary | undefined;
  for (const r of runs) {
    for (const e of r.events) {
      if (e.type === "plan") {
        plan = { ...e.data, runId: r.id, asking: e.data.questions.length > 0, approved: false, awaiting: false };
        features = undefined;
      } else if (e.type === "features") features = e.data;
    }
    if (plan && r.id === plan.runId) plan.awaiting = r.status === "done";
    if (plan && r.id !== plan.runId && r.mode === "build") plan.approved = true;
  }
  if (plan && features) Object.assign(plan, { features: features.features, total: features.total, passing: features.passing });
  return plan;
}

/** Mode for a typed prompt: while a plan waits for approval (or the planner asked questions),
 * what the user types revises the plan. Otherwise the server decides (auto). */
export function modeForPrompt(runs: Run[]): "auto" | "plan" {
  const p = planOf(runs);
  return p && !p.approved && p.awaiting ? "plan" : "auto";
}
