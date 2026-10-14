import { useMemo } from "react";
import { useStore } from "@/store/useStore";
import { brokenSet, buildArchitecture } from "./architecture";
import { buildWorkspace, normalizePath } from "./workspace";
import type { Run } from "./types";

const EMPTY: Run[] = [];
type Model = { runs: Run[]; liveRun?: Run; ws: ReturnType<typeof buildWorkspace>; arch: ReturnType<typeof buildArchitecture>; broken: Set<string> };
/** Many components read the model; compute it once per state change, not once per component. */
const cache = new WeakMap<Run[], { contents: unknown; tree: unknown; model: Model }>();

/** Everything the canvas, inspector and tabs derive from the active project's runs. */
export function useModel(): Model {
  const runs = useStore((s) => s.runs[s.projectId] ?? EMPTY);
  const contents = useStore((s) => s.contents[s.projectId]);
  const tree = useStore((s) => s.trees[s.projectId]);

  return useMemo(() => {
    const hit = cache.get(runs);
    if (hit && hit.contents === contents && hit.tree === tree) return hit.model;
    const liveRun = runs.find((r) => r.status === "running" || r.status === "queued");
    const ws = buildWorkspace(runs, liveRun?.id);
    // Files the server reports (optional endpoint) count even if no run in this browser touched them.
    for (const raw of tree ?? []) {
      const path = normalizePath(raw);
      if (path && !ws.files[path]) ws.files[path] = { path, edits: 0 };
    }
    // Merge known file text (demo writes / files endpoint / view_file captures).
    if (contents) {
      for (const [path, text] of Object.entries(contents)) {
        const f = (ws.files[path] ??= { path, edits: 0 });
        if (f.content === undefined) f.content = text;
      }
    }
    const arch = buildArchitecture(ws, runs);
    const broken = brokenSet(arch, runs);
    const model = { runs, liveRun, ws, arch, broken };
    cache.set(runs, { contents, tree, model });
    return model;
  }, [runs, contents, tree]);
}
