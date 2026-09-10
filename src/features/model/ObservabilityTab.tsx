import { useMemo, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { formatBytes, UNKNOWN } from "../../lib/format";
import type { InspectionBundle, ObservationPoint } from "../../lib/types";

export function ObservabilityTab({ bundle }: { bundle: InspectionBundle }) {
  const [search, setSearch] = useState("");
  const points = useMemo(
    () => (bundle.architecture.observations?.points ?? []) as ObservationPoint[],
    [bundle],
  );
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return points;
    return points.filter(
      (p) => p.path.toLowerCase().includes(q) || (p.meaning ?? "").toLowerCase().includes(q),
    );
  }, [points, search]);

  return (
    <Card border padding={24}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 8 }}>
        <Eyebrow>Observation catalog · {points.length} points</Eyebrow>
        <div style={{ flex: 1 }} />
        <Input
          placeholder="Search paths"
          value={search}
          onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
          style={{ width: 280 }}
        />
      </div>
      <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", margin: "0 0 16px" }}>
        Everything the architecture advertises as capturable during generation.
        Attention probabilities are not capturable in eredu — by design upstream.
        Capture support under the loaded backend is confirmed at load time.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) 90px 70px 120px",
          gap: 12,
          padding: "6px 0",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {["Path", "Meaning", "Dtype", "P / D", "Est. bytes"].map((h) => (
          <span key={h} className="sp-eyebrow" style={{ color: "var(--text)" }}>
            {h}
          </span>
        ))}
      </div>
      <div style={{ maxHeight: 560, overflow: "auto" }}>
        {filtered.map((p) => (
          <div
            key={p.path}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,2fr) minmax(0,2fr) 90px 70px 120px",
              gap: 12,
              padding: "6px 0",
              borderBottom: "1px solid var(--spiral-gray-200)",
              fontFamily: "var(--font-code)",
              fontSize: 12,
              alignItems: "baseline",
            }}
          >
            <span style={{ wordBreak: "break-all" }}>{p.path}</span>
            <span style={{ color: "var(--text-muted)" }}>{p.meaning ?? UNKNOWN}</span>
            <span>{p.dtype ?? UNKNOWN}</span>
            <span>
              <span style={{ color: p.prefill ? "var(--text)" : "var(--spiral-gray-200)" }}>P</span>{" "}
              <span style={{ color: p.decode ? "var(--text)" : "var(--spiral-gray-200)" }}>D</span>
            </span>
            <span style={{ color: "var(--text-muted)" }}>
              {p.retained_bytes != null ? formatBytes(p.retained_bytes) : UNKNOWN}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
            no matching observation points
          </p>
        )}
      </div>
    </Card>
  );
}
