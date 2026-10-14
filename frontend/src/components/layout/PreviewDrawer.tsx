import { useState } from "react";
import { ExternalLink, Loader2, Lock, MonitorSmartphone, RotateCw, Smartphone, X } from "lucide-react";
import { useStore } from "@/store/useStore";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** The live app, served from the sandbox through the API's preview proxy. */
export function PreviewDrawer() {
  const p = useStore((s) => s.preview);
  const { closePreview, openPreview } = useStore.getState();
  const [key, setKey] = useState(0);
  const [mobile, setMobile] = useState(false);
  if (!p.open) return null;

  return (
    <aside className="animate-pop absolute bottom-4 right-4 top-4 z-40 flex w-[min(720px,58%)] flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-float">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex gap-1.5 pl-1">
          <span className="h-2.5 w-2.5 rounded-full bg-line-2" /><span className="h-2.5 w-2.5 rounded-full bg-line-2" /><span className="h-2.5 w-2.5 rounded-full bg-line-2" />
        </div>
        <div className="ml-2 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-sunk px-2.5 font-mono text-[11px] text-mute">
          <Lock size={10} className="shrink-0" />
          <span className="truncate">{p.loading ? "requesting a preview link…" : p.url ?? "no preview"}</span>
        </div>
        <Button size="icon-sm" variant="ghost" title="Phone width" onClick={() => setMobile(!mobile)}>{mobile ? <MonitorSmartphone size={13} /> : <Smartphone size={13} />}</Button>
        <Button size="icon-sm" variant="ghost" title="Reload" onClick={() => { setKey((k) => k + 1); if (!p.html) openPreview(); }}><RotateCw size={13} /></Button>
        {p.url && !p.html && (
          <a href={p.url} target="_blank" rel="noreferrer" title="Open in a new tab" className="flex h-6 w-6 items-center justify-center rounded-md text-ink-2 hover:bg-sunk"><ExternalLink size={13} /></a>
        )}
        <Button size="icon-sm" variant="ghost" title="Close" onClick={closePreview}><X size={14} /></Button>
      </div>
      <div className="flex min-h-0 flex-1 items-stretch justify-center bg-[radial-gradient(#e5e0d6_1px,transparent_1px)] [background-size:16px_16px]">
        {p.loading ? (
          <div className="flex items-center gap-2 self-center text-[12px] text-mute"><Loader2 size={14} className="animate-spin" /> Connecting to the sandbox…</div>
        ) : p.error ? (
          <div className="max-w-sm self-center px-6 text-center">
            <p className="text-[13px] font-medium text-ink-2">Preview unavailable</p>
            <p className="mt-1 text-[12px] leading-relaxed text-mute">{p.error}</p>
          </div>
        ) : (
          <iframe
            key={key}
            title="Preview"
            src={p.html ? undefined : p.url}
            srcDoc={p.html}
            sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
            className={cn("h-full border-0 bg-white transition-all duration-300", mobile ? "my-4 w-[390px] rounded-2xl border border-line shadow-lift" : "w-full")}
          />
        )}
      </div>
      <div className="border-t border-line px-3 py-1.5 font-mono text-[10px] text-faint">Served from the sandbox on :3000 · link expires in 24h · hot reload not proxied</div>
    </aside>
  );
}
