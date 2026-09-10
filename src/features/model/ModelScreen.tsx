import { useEffect } from "react";
import { Tabs } from "../../goose/ui";
import { Heading } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { useModel } from "../../state/model";
import { useNav, type ModelTab } from "../../state/nav";
import { usePlans } from "../../state/plans";
import { formatArtifactFormat, repoDisplayName } from "../../lib/format";
import { OverviewTab } from "./OverviewTab";
import { ArchitectureTab } from "./ArchitectureTab";
import { TensorsTab } from "./TensorsTab";
import { TokenizerTab } from "./TokenizerTab";
import { ConfigTab } from "./ConfigTab";
import { ObservabilityTab } from "./ObservabilityTab";

const TABS: { value: ModelTab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "architecture", label: "Architecture" },
  { value: "tensors", label: "Tensors" },
  { value: "tokenizer", label: "Tokenizer" },
  { value: "config", label: "Config" },
  { value: "observability", label: "Observability" },
];

export function ModelScreen({ path, repoId, tab }: { path: string; repoId: string; tab: ModelTab }) {
  const back = useNav((s) => s.back);
  const go = useNav((s) => s.go);
  const setModelTab = useNav((s) => s.setModelTab);
  const entry = useModel((s) => s.inspections[path]);
  const inspect = useModel((s) => s.inspect);

  useEffect(() => {
    void inspect(path);
  }, [path, inspect]);

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
        <Button size="sm" variant="ghost" onClick={back}>
          ◀ Back
        </Button>
        <Heading size="md" color="ink" as="h1" style={{ fontSize: 26 }}>
          {repoDisplayName(repoId)}
        </Heading>
        {entry?.bundle && (
          <Eyebrow color="muted">
            {entry.bundle.family} · {entry.bundle.effectiveModelType} ·{" "}
            {formatArtifactFormat(entry.bundle.report.artifact_format)}
          </Eyebrow>
        )}
        <div style={{ flex: 1 }} />
        <Button
          size="sm"
          onClick={() => {
            usePlans.getState().setTargetArtifact({ path, label: repoDisplayName(repoId) });
            go({ name: "lab" });
          }}
        >
          Generate ▸
        </Button>
      </div>

      <Tabs items={TABS} value={tab} onChange={(v) => setModelTab(v as ModelTab)} style={{ marginBottom: 24 }} />

      {entry?.loading && (
        <Eyebrow color="muted">Inspecting — no weights loaded…</Eyebrow>
      )}
      {entry?.error && (
        <div
          style={{
            border: "1px solid var(--color-border-danger)",
            background: "var(--surface)",
            padding: 16,
            fontFamily: "var(--font-code)",
            fontSize: 13,
          }}
        >
          {entry.error}
        </div>
      )}
      {entry?.bundle && (
        <>
          {tab === "overview" && <OverviewTab bundle={entry.bundle} />}
          {tab === "architecture" && <ArchitectureTab bundle={entry.bundle} />}
          {tab === "tensors" && <TensorsTab bundle={entry.bundle} />}
          {tab === "tokenizer" && <TokenizerTab bundle={entry.bundle} path={path} />}
          {tab === "config" && <ConfigTab bundle={entry.bundle} />}
          {tab === "observability" && <ObservabilityTab bundle={entry.bundle} />}
        </>
      )}
    </div>
  );
}
