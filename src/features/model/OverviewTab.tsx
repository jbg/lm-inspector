import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { formatArtifactFormat, formatBytes, formatCount, UNKNOWN } from "../../lib/format";
import type { InspectionBundle, Readiness } from "../../lib/types";
import type { I64 } from "../../lib/lossless";
import { READINESS_FIELDS, ReadinessGlyph } from "./readiness";

export function OverviewTab({ bundle }: { bundle: InspectionBundle }) {
  const r = bundle.report;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
      <Card border padding={24}>
        <Eyebrow style={{ marginBottom: 16 }}>Readiness</Eyebrow>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {READINESS_FIELDS.map((f) => (
            <div
              key={f.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--spiral-gray-200)",
                paddingBottom: 6,
              }}
            >
              <span className="sp-eyebrow" style={{ color: "var(--text)" }}>
                {f.label}
              </span>
              <ReadinessGlyph state={(r[f.key] as Readiness) ?? "unverified"} />
            </div>
          ))}
        </div>

        {r.issues.length > 0 && (
          <>
            <Eyebrow style={{ margin: "20px 0 10px" }}>ISSUES ({r.issues.length})</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {r.issues.map((issue, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <Tag size="sm" color={issue.severity === "error" ? "accent" : "blue"}>
                    {issue.severity}
                  </Tag>
                  <div style={{ fontFamily: "var(--font-code)", fontSize: 12, lineHeight: 1.5 }}>
                    <span style={{ color: "var(--text-muted)" }}>{issue.code}</span>{" "}
                    {issue.detail}
                    {issue.tensor_name && (
                      <span style={{ color: "var(--text-muted)" }}> · {issue.tensor_name}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        {r.requirements.length > 0 && (
          <>
            <Eyebrow style={{ margin: "20px 0 10px" }}>Requirements</Eyebrow>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r.requirements.map((req, i) => (
                <div key={i} style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>
                  <ReadinessGlyph state={req.readiness} /> {req.detail}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <Card border padding={24}>
          <Eyebrow style={{ marginBottom: 16 }}>Identity</Eyebrow>
          <IdentityRow label="Family" value={bundle.family} />
          <IdentityRow label="Model type" value={bundle.effectiveModelType} mono />
          <IdentityRow label="Format" value={formatArtifactFormat(r.artifact_format)} />
          <IdentityRow label="Tensors" value={r.tensor_count != null ? formatCount(r.tensor_count) : UNKNOWN} />
          <IdentityRow
            label="Shards"
            value={r.checkpoint_shards != null ? String(r.checkpoint_shards) : UNKNOWN}
          />
          <IdentityRow label="Path" value={r.path} mono small />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
            {r.expected_modalities.map((m) => (
              <Tag size="sm" key={m}>
                {m}
              </Tag>
            ))}
            {r.tensor_encodings.map((e) => (
              <Tag size="sm" color="ink" key={e.name}>
                {e.name}
              </Tag>
            ))}
          </div>
        </Card>

        <Card border padding={24}>
          <Eyebrow style={{ marginBottom: 16 }}>Resources</Eyebrow>
          <ResourceRows resources={r.resources} />
        </Card>
      </div>
    </div>
  );
}

function IdentityRow({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        borderBottom: "1px solid var(--spiral-gray-200)",
        padding: "6px 0",
      }}
    >
      <span className="sp-eyebrow" style={{ color: "var(--text)", flex: "none" }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: mono ? "var(--font-code)" : "var(--font-body)",
          fontSize: small ? 11 : 13,
          fontWeight: 500,
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

const RESOURCE_LABELS: Record<string, string> = {
  stored_tensor_bytes: "Stored tensors",
  largest_stored_tensor_bytes: "Largest tensor",
  materialized_parameter_bytes: "Materialized params",
  pinned_parameter_bytes: "Pinned params",
  largest_execution_group_bytes: "Largest exec group",
  largest_adjacent_execution_groups_bytes: "Largest adjacent groups",
  expert_parameter_bytes: "Expert params",
};

function ResourceRows({ resources }: { resources: Record<string, unknown> }) {
  const rows = Object.entries(RESOURCE_LABELS)
    .map(([key, label]) => ({ label, raw: resources[key] }))
    .filter((row) => row.raw !== undefined);
  if (rows.length === 0) {
    return <span style={{ color: "var(--text-muted)" }}>{UNKNOWN}</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => {
        const observed = decodeObserved(row.raw);
        return (
          <div key={row.label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <span className="sp-eyebrow" style={{ color: "var(--text)" }}>
              {row.label}
            </span>
            <span style={{ fontFamily: "var(--font-code)", fontSize: 13 }} title={observed.provenance}>
              {observed.value !== undefined ? (
                <>
                  {formatBytes(observed.value)}
                  {observed.kind && (
                    <sup style={{ color: "var(--text-muted)", marginLeft: 3 }}>
                      {observed.kind[0]}
                    </sup>
                  )}
                </>
              ) : (
                <span
                  style={{ color: "var(--text-muted)" }}
                  title={observed.reason ? `Not measured — ${observed.reason}` : "Not measured"}
                >
                  {UNKNOWN}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** eredu `Observed<T>` serializes tagged on "status":
 *  {status:"available", value, kind, source} | {status:"unsupported"|"unavailable", reason}.
 *  Any unrecognized shape stays unknown — never zero. */
function decodeObserved(raw: unknown): {
  value?: I64;
  kind?: string;
  provenance?: string;
  reason?: string;
} {
  if (typeof raw === "number" || typeof raw === "string") return { value: raw };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.status === "available" && (typeof o.value === "number" || typeof o.value === "string")) {
      return {
        value: o.value,
        kind: typeof o.kind === "string" ? o.kind : undefined,
        provenance: typeof o.source === "string" ? o.source : undefined,
      };
    }
    if (typeof o.reason === "string") return { reason: o.reason };
  }
  return {};
}
