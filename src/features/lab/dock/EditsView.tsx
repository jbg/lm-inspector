// Interventions: quick builders over the discovered points (attached to the
// NEXT run from the composer state) and per-token outcome rows with
// before/after evidence for the viewed run.

import { useMemo, useState } from "react";
import { Eyebrow } from "../../../goose/ui";
import { Tag } from "../../../goose/ui";
import { Button } from "../../../goose/ui";
import { Input } from "../../../goose/ui";
import { Select } from "../../../goose/ui";
import { useSession } from "../../../state/session";
import { usePlans, type InterventionDraft } from "../../../state/plans";
import { useUi } from "../../../state/ui";
import { i64ToNumber } from "../../../lib/lossless";
import type { RunJournal } from "../../../state/journal/journal";
import type { CaptureRecord, InterventionRecord, SummaryPayload } from "../../../state/journal/reconcile";

interface DiscoveredPoint {
  path: string;
  stage?: string;
  operations?: string[];
  dtypes?: string[];
  conditions?: string[];
}

export function EditsView({ journal }: { journal: RunJournal }) {
  const derived = journal.derived;
  const selection = useUi((s) => s.selection);
  const predictionIndex =
    selection?.runId === derived.runId ? selection.predictionIndex : undefined;
  const records =
    predictionIndex !== undefined
      ? (derived.interventionsByPrediction.get(predictionIndex) ?? [])
      : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Eyebrow style={{ marginBottom: 8 }}>
          Outcomes {predictionIndex !== undefined ? `at token ${predictionIndex}` : "(select a token)"}
        </Eyebrow>
        {records.length === 0 ? (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            no intervention records at this position
          </p>
        ) : (
          records.map((record, i) => <OutcomeRow key={i} record={record} />)
        )}
      </div>
      <EditsBuilder />
    </div>
  );
}

function outcomeMeta(outcome: unknown): { label: string; color: string } {
  const kind =
    typeof outcome === "object" && outcome !== null
      ? ((outcome as { kind?: string }).kind ?? "unknown")
      : String(outcome);
  switch (kind) {
    case "applied":
      return { label: "Applied", color: "blue" };
    case "inactive":
      return { label: "Inactive", color: "ink" };
    case "missing":
      return { label: "Missing", color: "accent" };
    case "failed":
      return { label: "Failed", color: "accent" };
    default:
      return { label: kind.replace(/_/g, " "), color: "ink" };
  }
}

function OutcomeRow({ record }: { record: InterventionRecord }) {
  const meta = outcomeMeta(record.outcome);
  const evidence = record.evidence ?? [];
  const before = evidence.find((e) => e.position === "before_intervention" || /before/i.test(String(e.position)));
  const after = evidence.find((e) => e.position === "after_intervention" || /after/i.test(String(e.position)));
  return (
    <div style={{ borderBottom: "1px solid var(--spiral-gray-200)", padding: "8px 0" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Tag size="sm" color={meta.color} filled={meta.label === "Applied"}>
          {meta.label}
        </Tag>
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11 }}>
          {record.operation_id} · {record.target}
        </span>
      </div>
      {(before || after) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
          <EvidenceCell label="Before" record={before} />
          <EvidenceCell label="After" record={after} />
        </div>
      )}
    </div>
  );
}

function EvidenceCell({ label, record }: { label: string; record?: CaptureRecord }) {
  const summary = record?.payload?.kind === "summary" ? (record.payload.value as SummaryPayload) : undefined;
  return (
    <div>
      <Eyebrow color="muted">{label}</Eyebrow>
      {summary ? (
        <div style={{ fontFamily: "var(--font-code)", fontSize: 11 }}>
          rms {summary.rms == null ? "—" : summary.rms.toPrecision(4)} · mean{" "}
          {summary.mean == null ? "—" : summary.mean.toPrecision(4)} · nan {i64ToNumber(summary.nan ?? 0)}
        </div>
      ) : (
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>—</span>
      )}
    </div>
  );
}

function EditsBuilder() {
  const session = useSession();
  const plans = usePlans();
  const [targetPath, setTargetPath] = useState("");
  const [action, setAction] = useState<"zero" | "scale" | "maskLogits">("scale");
  const [factor, setFactor] = useState("0");

  const points = useMemo(() => {
    const raw = (session.interventionDiscovery?.points ?? []) as unknown as DiscoveredPoint[];
    return raw;
  }, [session.interventionDiscovery]);

  const point = points.find((p) => p.path === targetPath);
  const dtype = point?.dtypes?.[0] ?? "float32";

  const add = () => {
    if (!targetPath) return;
    const draft: InterventionDraft = {
      id: `edit-${plans.interventions.length + 1}`,
      target: targetPath,
      action:
        action === "zero"
          ? { kind: "zero", dtype }
          : action === "scale"
            ? { kind: "scale", dtype, factor: Number(factor) || 0 }
            : { kind: "maskLogits", dtype, tokenIds: [] },
      every: 1,
      evidence: "summary",
    };
    plans.setInterventions([...plans.interventions, draft]);
  };

  return (
    <div>
      <Eyebrow style={{ marginBottom: 8 }}>Attach to next run</Eyebrow>
      {points.length === 0 ? (
        <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
          no intervention points discovered for this load
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Select
            label="Target"
            options={points.map((p) => ({
              value: p.path,
              label: `${p.path}${p.stage ? ` · ${p.stage}` : ""}`,
            }))}
            value={targetPath}
            placeholder="pick an intervention point"
            onChange={setTargetPath}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <Select
              label="Action"
              options={[
                { value: "scale", label: "Scale" },
                { value: "zero", label: "Zero" },
                { value: "maskLogits", label: "Ban tokens" },
              ]}
              value={action}
              onChange={(v) => setAction(v as typeof action)}
              style={{ width: 140 }}
            />
            {action === "scale" && (
              <Input label="Factor" type="number" value={factor} onChange={(e) => setFactor((e.target as HTMLInputElement).value)} style={{ width: 100 }} />
            )}
            <Button size="sm" variant="secondary" onClick={add} disabled={!targetPath}>
              + Add
            </Button>
          </div>
          {plans.interventions.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {plans.interventions.map((op, i) => (
                <div key={op.id} style={{ display: "flex", gap: 8, alignItems: "center", fontFamily: "var(--font-code)", fontSize: 11 }}>
                  <Tag size="sm">{op.action.kind}</Tag>
                  <span style={{ flex: 1, wordBreak: "break-all" }}>{op.target}</span>
                  <button
                    onClick={() => plans.setInterventions(plans.interventions.filter((_, j) => j !== i))}
                    style={{ background: "none", border: "1px solid var(--border)", cursor: "pointer" }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: 0 }}>
                prospective only — applies to future steps of the NEXT run; past
                KV state is never recomputed · limits 64 ops / 1 MiB plan
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
