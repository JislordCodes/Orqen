import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { useStore } from "@/store/useStore";
import { TopBar } from "@/components/layout/TopBar";
import { Canvas } from "@/components/canvas/Canvas";
import { Inspector } from "@/components/inspector/Inspector";
import { ChatDock } from "@/components/chat/ChatDock";
import { PreviewDrawer } from "@/components/layout/PreviewDrawer";
import { ExecutionsView } from "@/components/executions/ExecutionsView";
import { TestsView } from "@/components/tests/TestsView";
import { NewProjectDialog, SettingsDialog, Toasts } from "@/components/layout/Dialogs";

export default function App() {
  const tab = useStore((s) => s.tab);
  const mode = useStore((s) => s.mode);

  useEffect(() => {
    const s = useStore.getState();
    s.checkHealth();
    s.resumeStreams();
    s.syncTree();
  }, [mode]);

  // Esc closes the inspector / preview
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target as HTMLElement).closest("input,textarea")) return;
      const s = useStore.getState();
      if (s.preview.open) s.closePreview();
      else if (s.selectedNodeId) s.select(undefined);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      <main className="relative min-h-0 flex-1">
        {/* Canvas stays mounted so its viewport survives tab switches. */}
        <div className={tab === "editor" ? "absolute inset-0" : "pointer-events-none invisible absolute inset-0"}>
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
          <Inspector />
          <ChatDock />
          <PreviewDrawer />
        </div>
        {tab === "executions" && <div className="absolute inset-0 z-10 bg-paper"><ExecutionsView /></div>}
        {tab === "tests" && <div className="absolute inset-0 z-10 bg-paper"><TestsView /></div>}
      </main>
      <SettingsDialog />
      <NewProjectDialog />
      <Toasts />
    </div>
  );
}
