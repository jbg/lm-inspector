import { Card } from "../../../goose/ui";
import { useUi, type DockTab } from "../../../state/ui";
import type { RunJournal } from "../../../state/journal/journal";
import { AlternatesPanel } from "./AlternatesPanel";
import { SignalsView } from "./SignalsView";
import { ComponentsPanel } from "./ComponentsPanel";
import { EditsView } from "./EditsView";
import { StatsView } from "./StatsView";

const TABS: { value: DockTab; label: string }[] = [
  { value: "alternates", label: "Alternates" },
  { value: "signals", label: "Signals" },
  { value: "components", label: "Components" },
  { value: "edits", label: "Edits" },
  { value: "stats", label: "Stats" },
];

export function Dock({ journal }: { journal: RunJournal }) {
  const tab = useUi((s) => s.dockTab);
  const setTab = useUi((s) => s.setDockTab);
  return (
    <Card border padding={16} style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "auto" }}>
      {/* Compact tab row: the Spiral Tabs component is page-scale (18px
          Silkscreen) and overflows a dock column; this keeps its visual
          language — uppercase, magenta underline on the active item — at
          eyebrow scale. */}
      <div
        role="tablist"
        style={{
          display: "flex",
          gap: 14,
          borderBottom: "1px solid var(--spiral-gray-200)",
          marginBottom: 14,
        }}
      >
        {TABS.map((t) => {
          const on = t.value === tab;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.value)}
              className="sp-eyebrow"
              style={{
                background: "none",
                border: 0,
                borderBottom: `2px solid ${on ? "var(--accent)" : "transparent"}`,
                marginBottom: -1,
                padding: "4px 0 8px",
                cursor: "pointer",
                color: on ? "var(--accent)" : "var(--text)",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === "alternates" && <AlternatesPanel journal={journal} />}
      {tab === "signals" && <SignalsView journal={journal} />}
      {tab === "components" && <ComponentsPanel journal={journal} />}
      {tab === "edits" && <EditsView journal={journal} />}
      {tab === "stats" && <StatsView journal={journal} />}
    </Card>
  );
}
