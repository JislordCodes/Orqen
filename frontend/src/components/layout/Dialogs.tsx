import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useStore } from "@/store/useStore";
import { api } from "@/lib/api";
import { cn, slugify } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, Field, inputCls } from "@/components/ui/misc";

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const conn = useStore((s) => s.conn);
  const mode = useStore((s) => s.mode);
  const { setSettingsOpen, setConn, setMode, checkHealth } = useStore.getState();
  const [url, setUrl] = useState(conn.baseUrl);
  const [user, setUser] = useState(conn.userId);
  const [m, setM] = useState(mode);
  const [test, setTest] = useState<"idle" | "busy" | "ok" | "fail">("idle");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) { setUrl(conn.baseUrl); setUser(conn.userId); setM(mode); setTest("idle"); }
  }, [open, conn, mode]);

  const userOk = /^[A-Za-z0-9_-]{1,40}$/.test(user);
  const run = async () => {
    setTest("busy");
    try {
      await api.health({ baseUrl: url, userId: user });
      setTest("ok");
    } catch (e) {
      setErr((e as Error).message);
      setTest("fail");
    }
  };
  const save = () => {
    setConn({ baseUrl: url.trim(), userId: user.trim() });
    setMode(m);
    setSettingsOpen(false);
    setTimeout(checkHealth, 0);
  };

  return (
    <Dialog open={open} onClose={() => setSettingsOpen(false)} title="Connection">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunk p-1">
          {(["live", "demo"] as const).map((x) => (
            <button key={x} onClick={() => setM(x)} className={cn("rounded-lg py-1.5 text-[12.5px] font-medium capitalize transition-all", m === x ? "bg-card shadow-card" : "text-mute hover:text-ink")}>
              {x === "live" ? "Live backend" : "Demo (no backend)"}
            </button>
          ))}
        </div>
        {m === "demo" ? (
          <p className="rounded-xl border border-line bg-paper p-3 text-[12px] leading-relaxed text-ink-2">
            A scripted agent emits the same events the worker does, so every screen works without Redis, Docker or a model key. Try prompts with “auth”, “stripe”, “rename a field”, “tests” or “audit”.
          </p>
        ) : (
          <>
            <Field label="API address" hint="Where uvicorn app.api:app is running. CORS allows localhost:5173.">
              <input className={inputCls} value={url} onChange={(e) => { setUrl(e.target.value); setTest("idle"); }} placeholder="http://localhost:8000" />
            </Field>
            <Field label="User id (dev auth)" hint="Sent as X-User-Id. Names your sandbox container, so keep it stable.">
              <input className={cn(inputCls, !userOk && "border-bad")} value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={run} disabled={test === "busy"}>
                {test === "busy" && <Loader2 size={12} className="animate-spin" />} Test connection
              </Button>
              {test === "ok" && <span className="flex items-center gap-1 text-[12px] text-ok"><CheckCircle2 size={13} /> API and Redis are up</span>}
              {test === "fail" && <span className="flex items-center gap-1 text-[12px] text-bad"><XCircle size={13} /> {err}</span>}
            </div>
          </>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(false)}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={save} disabled={m === "live" && (!userOk || !url.trim())}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function NewProjectDialog() {
  const open = useStore((s) => s.newProjectOpen);
  const { setNewProjectOpen, createProject } = useStore.getState();
  const [name, setName] = useState("");
  useEffect(() => { if (open) setName(""); }, [open]);
  const slug = slugify(name);
  return (
    <Dialog open={open} onClose={() => setNewProjectOpen(false)} title="New project" width={400}>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) createProject(name); }} className="space-y-4">
        <Field label="Name" hint={<>Gets its own sandbox, files and agent memory. Id: <span className="font-mono">{slug || "…"}</span></>}>
          <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer portal" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => setNewProjectOpen(false)}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={!name.trim()}>Create</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed left-1/2 top-28 z-[60] flex w-[calc(100%-1.5rem)] -translate-x-1/2 md:top-16 md:w-auto flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cn(
            "animate-pop pointer-events-auto max-w-md rounded-xl border px-3.5 py-2 text-left text-[12.5px] shadow-lift",
            t.tone === "error" ? "border-bad/30 bg-bad-soft text-bad" : t.tone === "ok" ? "border-ok/25 bg-ok-soft text-ok" : "border-line bg-card text-ink",
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
