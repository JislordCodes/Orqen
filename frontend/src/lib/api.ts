import type { ServerEvent } from "./types";

/**
 * Client for backend/app/api.py. Only these routes exist today:
 *   GET  /health
 *   POST /runs                 { prompt, project_id }   -> { run_id, project_id }   (409 if a run is active)
 *   GET  /runs/{id}/events     SSE: status | text | tool_start | tool_result | done | error
 *   POST /preview              { project_id }           -> { url, expires_in }      (501 if no PREVIEW_DOMAIN)
 * Optional (see README "Optional backend endpoints"): file tree + file content for the code view.
 */

export interface Connection {
  baseUrl: string;
  userId: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(c: Connection, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${c.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", "X-User-Id": c.userId, ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, `Can't reach the API at ${c.baseUrl}. Is uvicorn running?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, String(detail));
  }
  return res.json();
}

export const api = {
  health: (c: Connection) => call<{ ok: boolean }>(c, "/health"),

  startRun: (c: Connection, prompt: string, projectId: string) =>
    call<{ run_id: string; project_id: string }>(c, "/runs", {
      method: "POST",
      body: JSON.stringify({ prompt, project_id: projectId }),
    }),

  preview: (c: Connection, projectId: string) =>
    call<{ url: string; expires_in: number }>(c, "/preview", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId }),
    }),

  /** Optional endpoint. Returns null when the backend doesn't have it yet. */
  async fileContent(c: Connection, projectId: string, path: string): Promise<string | null> {
    try {
      const r = await call<{ content: string }>(
        c,
        `/projects/${projectId}/file?path=${encodeURIComponent(path)}`,
      );
      return r.content;
    } catch {
      return null;
    }
  },

  async fileTree(c: Connection, projectId: string): Promise<string[] | null> {
    try {
      return (await call<{ files: string[] }>(c, `/projects/${projectId}/files`)).files;
    } catch {
      return null;
    }
  },

  /**
   * Stream a run's events. EventSource can't set headers, but current_user() also
   * accepts ?user_id=, and EventSource resends Last-Event-ID on reconnect, which the
   * backend uses to replay from the Redis Stream.
   */
  streamRun(c: Connection, runId: string, onEvent: (e: ServerEvent, id: string) => void, onFail: (msg: string) => void) {
    const url = `${c.baseUrl.replace(/\/$/, "")}/runs/${runId}/events?user_id=${encodeURIComponent(c.userId)}`;
    const es = new EventSource(url);
    let finished = false;
    const types = ["status", "text", "tool_start", "tool_result", "done", "error"] as const;
    for (const t of types) {
      es.addEventListener(t, (msg) => {
        const m = msg as MessageEvent;
        let data: unknown = {};
        try {
          data = JSON.parse(m.data);
        } catch {
          data = { text: m.data };
        }
        onEvent({ type: t, data } as ServerEvent, m.lastEventId);
        if (t === "done" || t === "error") {
          finished = true;
          es.close();
        }
      });
    }
    let failures = 0;
    es.onerror = () => {
      if (finished) return;
      failures += 1;
      if (failures > 5) {
        es.close();
        onFail("Lost the event stream. The run may still be going on the server.");
      }
    };
    es.onopen = () => (failures = 0);
    return () => es.close();
  },
};
