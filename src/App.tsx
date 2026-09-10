import { TopBar } from "./app/TopBar";
import { useNav } from "./state/nav";
import { LibraryScreen } from "./features/library/LibraryScreen";
import { ModelScreen } from "./features/model/ModelScreen";
import { LabScreen } from "./features/lab/LabScreen";
import { RunsScreen } from "./features/runs/RunsScreen";

export default function App() {
  const view = useNav((s) => s.view);
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main">
        {view.name === "library" && <LibraryScreen />}
        {view.name === "model" && <ModelScreen path={view.path} repoId={view.repoId} tab={view.tab} />}
        {view.name === "lab" && <LabScreen />}
        {(view.name === "runs" || view.name === "compare") && <RunsScreen />}
      </main>
    </div>
  );
}
