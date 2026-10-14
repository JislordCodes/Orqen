import { useEffect } from "react";
import { Editor } from "@monaco-editor/react";
import { Eye, FileQuestion, MessageSquarePlus } from "lucide-react";
import { useStore } from "@/store/useStore";
import { useModel } from "@/lib/useModel";
import type { Component } from "@/lib/types";
import { basename, cn, languageFor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/misc";

/** Monaco, light theme, read-only: changes go through the agent so the canvas never drifts from the code. */
export function CodeView({ node }: { node: Component }) {
  const { ws, liveRun } = useModel();
  const openFile = useStore((s) => s.openFile);
  const { setOpenFile, loadFile, setDraft, send } = useStore.getState();
  const file = openFile && node.files.includes(openFile) ? openFile : node.files.find((f) => !/\.(md|json|txt)$/.test(f)) ?? node.files[0];
  const info = file ? ws.files[file] : undefined;

  useEffect(() => {
    if (file && info?.content === undefined) loadFile(file);
  }, [file, info?.content, loadFile]);

  if (!node.files.length) return <Empty icon={<FileQuestion size={22} />} title="No files">This component isn't backed by files (yet).</Empty>;

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2">
        {node.files.map((f) => (
          <button
            key={f}
            title={f}
            onClick={() => setOpenFile(f)}
            className={cn("shrink-0 rounded-md px-2 py-1 font-mono text-[11px] transition-colors", f === file ? "bg-ink text-paper" : "text-mute hover:bg-sunk hover:text-ink", ws.files[f]?.error && f !== file && "text-bad")}
          >
            {basename(f)}
          </button>
        ))}
      </div>
      {file && (
        <div className="flex items-center justify-between px-4 py-1.5 font-mono text-[10.5px] text-mute">
          <span className="truncate">{file}</span>
          <button onClick={() => setDraft(`In ${file}: `, node.id)} className="flex items-center gap-1 hover:text-ink"><MessageSquarePlus size={11} /> ask about this file</button>
        </div>
      )}
      {info?.error && <pre className="mx-3 mb-2 max-h-28 overflow-auto rounded-lg bg-bad-soft p-2 font-mono text-[10.5px] whitespace-pre-wrap text-bad">{info.error}</pre>}
      <div className="min-h-0 flex-1 border-t border-line">
        {info?.content !== undefined ? (
          <Editor
            key={file}
            value={info.content}
            language={languageFor(file!)}
            theme="orqen-paper"
            beforeMount={defineTheme}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
              lineNumbersMinChars: 3,
              scrollBeyondLastLine: false,
              renderLineHighlight: "none",
              padding: { top: 10, bottom: 10 },
              overviewRulerLanes: 0,
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        ) : (
          <Empty icon={<Eye size={22} />} title="Contents not loaded">
            <p>The agent wrote this file{info?.chars ? ` (${info.chars.toLocaleString()} chars)` : ""}, but the API doesn't serve file contents yet.</p>
            <Button size="xs" variant="secondary" className="mt-3" disabled={!!liveRun} onClick={() => send(`Show me the full contents of ${file} with view_file. Don't change anything.`, { intent: "build" })}>
              Ask the agent to open it
            </Button>
          </Empty>
        )}
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defineTheme(monaco: any) {
  monaco.editor.defineTheme("orqen-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "a29d93", fontStyle: "italic" },
      { token: "keyword", foreground: "c2410c" },
      { token: "string", foreground: "2e7d4f" },
      { token: "number", foreground: "8b5cf6" },
      { token: "type", foreground: "4a63e7" },
      { token: "delimiter", foreground: "8c877d" },
    ],
    colors: {
      "editor.background": "#fdfcf9",
      "editor.foreground": "#1a1916",
      "editorLineNumber.foreground": "#cfc8bb",
      "editorLineNumber.activeForeground": "#8c877d",
      "editor.selectionBackground": "#ffe1d4",
      "editorIndentGuide.background1": "#efebe3",
      "editorCursor.foreground": "#ff5a1f",
    },
  });
}
