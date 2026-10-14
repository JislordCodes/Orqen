import { useState } from "react";
import { ArrowUpRight, Github, Plus } from "lucide-react";
import { useStore } from "@/store/useStore";
import { Button } from "@/components/ui/button";

export const TEMPLATES = [
  { title: "Task tracker", prompt: "Build a small task tracker: a React front end, a Flask API with create, toggle and delete, SQLite storage, and tests for the main flow. Run it." },
  { title: "SaaS starter", prompt: "Build a Next.js SaaS starter with email sign-in, a dashboard page, a Postgres database via Prisma, and a Stripe checkout route. Run it." },
  { title: "REST API", prompt: "Build a FastAPI service for a bookstore: books and authors with CRUD endpoints, SQLAlchemy models, input validation, and pytest tests. Run it." },
];

/** The first-run state: one obvious action, like n8n's "Add first step". */
export function EmptyCanvas() {
  const setDraft = useStore((s) => s.setDraft);
  const send = useStore((s) => s.send);
  const importRepo = useStore((s) => s.importRepo);
  const [url, setUrl] = useState("");
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-28">
      <div className="pointer-events-auto flex w-[580px] max-w-[92%] flex-col items-center text-center">
        <button
          onClick={() => setDraft("", null)}
          className="group flex h-[88px] w-[88px] items-center justify-center rounded-2xl border-[1.5px] border-dashed border-line-2 bg-card/60 text-mute transition-all hover:-translate-y-0.5 hover:border-ink hover:text-ink hover:shadow-lift"
          aria-label="Describe your system"
        >
          <Plus size={26} strokeWidth={1.5} />
        </button>
        <h1 className="dot mt-7 text-[34px] leading-none tracking-tight text-ink">describe your system</h1>
        <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-mute">
          The agent writes real code in a private sandbox. Every page, endpoint, table and service it creates appears here as a node, wired to what it depends on.
        </p>
        <div className="mt-7 grid w-full grid-cols-3 gap-2.5">
          {TEMPLATES.map((t) => (
            <button
              key={t.title}
              onClick={() => send(t.prompt)}
              className="group rounded-xl border border-line bg-card p-3 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-line-2 hover:shadow-lift"
            >
              <div className="flex items-center justify-between text-[12.5px] font-semibold">
                {t.title}
                <ArrowUpRight size={13} className="text-faint transition-colors group-hover:text-signal" />
              </div>
              <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-mute">{t.prompt}</p>
            </button>
          ))}
        </div>
        <div className="mt-5 flex w-full items-center gap-3 text-[11px] text-faint">
          <span className="h-px flex-1 bg-line" /> or map an existing codebase <span className="h-px flex-1 bg-line" />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            importRepo(url);
          }}
          className="mt-3 flex w-full items-center gap-2 rounded-xl border border-line bg-card p-1 pl-3 shadow-card focus-within:border-ink/40"
        >
          <Github size={14} className="shrink-0 text-mute" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" className="h-8 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-faint" />
          <Button type="submit" size="sm" variant="primary" disabled={!url.trim()}>Map repo</Button>
        </form>
      </div>
    </div>
  );
}
