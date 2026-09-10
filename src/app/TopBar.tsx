import { useNav } from "../state/nav";
import { useSession } from "../state/session";

const AREAS = [
  { key: "library", label: "Library" },
  { key: "lab", label: "Lab" },
  { key: "runs", label: "Runs" },
] as const;

export function TopBar() {
  const view = useNav((s) => s.view);
  const go = useNav((s) => s.go);
  const active =
    view.name === "model" ? "library" : view.name === "compare" ? "runs" : view.name;

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 24,
        background: "var(--color-background-primary)",
        borderBottom: "1px solid var(--color-border-primary)",
        color: "var(--color-text-primary)",
        padding: "0 20px",
        height: 52,
        flex: "none",
      }}
    >
      <span style={{ fontWeight: 500, fontSize: "var(--font-text-md-size)", whiteSpace: "nowrap" }}>
        LM Inspector
      </span>
      <nav style={{ display: "flex", gap: 4, flex: 1 }}>
        {AREAS.map((a) => {
          const on = active === a.key;
          return (
            <button
              key={a.key}
              onClick={() => {
                if (a.key === "library") go({ name: "library" });
                else if (a.key === "lab") go({ name: "lab" });
                else go({ name: "runs" });
              }}
              style={{
                background: on ? "var(--color-background-secondary)" : "none",
                color: on ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                border: "none",
                borderRadius: "var(--border-radius-md)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-text-sm-size)",
                fontWeight: 500,
                padding: "6px 14px",
                cursor: "pointer",
              }}
            >
              {a.label}
            </button>
          );
        })}
      </nav>
      <ModelChip />
    </header>
  );
}

function ModelChip() {
  const load = useSession((s) => s.load);
  const unload = useSession((s) => s.unloadModel);
  const go = useNav((s) => s.go);
  const chip = (extra: React.CSSProperties): React.CSSProperties => ({
    fontFamily: "var(--font-sans)",
    fontSize: "var(--font-text-xs-size)",
    fontWeight: 500,
    padding: "5px 12px",
    borderRadius: "var(--border-radius-full)",
    whiteSpace: "nowrap",
    ...extra,
  });

  if (load.phase === "loaded") {
    const drafting = load.info.drafting !== "disabled";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => go({ name: "lab" })}
          style={chip({
            background: "var(--color-background-inverse)",
            color: "var(--color-text-inverse)",
            border: "none",
            cursor: "pointer",
          })}
        >
          {load.info.modelLabel}
          {drafting ? ` · ${load.info.drafting}` : ""}
        </button>
        <button
          onClick={() => void unload()}
          style={chip({
            background: "none",
            border: "1px solid var(--color-border-secondary)",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          })}
        >
          Unload
        </button>
      </span>
    );
  }
  if (load.phase === "loading") {
    return (
      <span
        style={chip({
          border: "1px solid var(--color-border-info)",
          color: "var(--color-text-info)",
        })}
      >
        Loading · {load.stage.replace(/_/g, " ")}
      </span>
    );
  }
  return (
    <span
      style={chip({
        border: "1px solid var(--color-border-primary)",
        color: "var(--color-text-tertiary)",
      })}
    >
      No model loaded
    </span>
  );
}
