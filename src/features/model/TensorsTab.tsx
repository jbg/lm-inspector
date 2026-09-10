import { useMemo, useRef, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { Select } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { formatBytes, formatCount } from "../../lib/format";
import { i64ToNumber } from "../../lib/lossless";
import type { InspectionBundle, TensorDescriptor } from "../../lib/types";

const ROW_HEIGHT = 28;
const OVERSCAN = 12;

function dtypeLabel(d: TensorDescriptor["dtype"]): string {
  if (typeof d === "string") return d.toUpperCase();
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    if (typeof o.encoded === "string") return o.encoded.toUpperCase();
    const key = Object.keys(o)[0];
    if (key) {
      const v = o[key];
      return `${key}${typeof v === "string" ? `:${v}` : ""}`.toUpperCase();
    }
  }
  return String(d).toUpperCase();
}

function isEncoded(d: TensorDescriptor["dtype"]): boolean {
  return typeof d === "object" && d !== null && "encoded" in (d as object);
}

function tensorBytes(t: TensorDescriptor): number {
  const len = t.storage?.length;
  return len != null ? i64ToNumber(len) : 0;
}

/** Collapse names to top-level prefixes for skimming: model.layers.N.* → model.layers.*. */
function prefixOf(name: string): string {
  return name.replace(/\.\d+\./, ".*.").split(".").slice(0, 4).join(".");
}

export function TensorsTab({ bundle }: { bundle: InspectionBundle }) {
  const tensors = bundle.tensors;
  const [search, setSearch] = useState("");
  const [dtypeFilter, setDtypeFilter] = useState("");
  const [prefixFilter, setPrefixFilter] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const dtypes = useMemo(
    () => [...new Set(tensors.map((t) => dtypeLabel(t.dtype)))].sort(),
    [tensors],
  );

  const prefixes = useMemo(() => {
    const map = new Map<string, { count: number; bytes: number }>();
    for (const t of tensors) {
      const p = prefixOf(t.name);
      const e = map.get(p) ?? { count: 0, bytes: 0 };
      e.count++;
      e.bytes += tensorBytes(t);
      map.set(p, e);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tensors]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tensors.filter(
      (t) =>
        (!q || t.name.toLowerCase().includes(q)) &&
        (!dtypeFilter || dtypeLabel(t.dtype) === dtypeFilter) &&
        (!prefixFilter || prefixOf(t.name) === prefixFilter),
    );
  }, [tensors, search, dtypeFilter, prefixFilter]);

  const totalBytes = useMemo(() => tensors.reduce((acc, t) => acc + tensorBytes(t), 0), [tensors]);
  const maxBytes = useMemo(() => Math.max(1, ...filtered.map(tensorBytes)), [filtered]);

  const viewportH = 560;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(filtered.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", gap: 20, alignItems: "start" }}>
      <Card border padding={16} style={{ maxHeight: 640, overflow: "auto" }}>
        <Eyebrow style={{ marginBottom: 10 }}>Modules</Eyebrow>
        <button
          onClick={() => setPrefixFilter(null)}
          style={moduleRowStyle(prefixFilter === null)}
        >
          <span>All</span>
          <span style={{ color: "var(--text-muted)" }}>{formatCount(tensors.length)}</span>
        </button>
        {prefixes.map(([p, info]) => (
          <button key={p} onClick={() => setPrefixFilter(p)} style={moduleRowStyle(prefixFilter === p)}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p}</span>
            <span style={{ color: "var(--text-muted)", flex: "none" }}>
              {info.count} · {formatBytes(info.bytes)}
            </span>
          </button>
        ))}
      </Card>

      <div>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <Input
            placeholder="Search tensor names"
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            style={{ flex: 1 }}
          />
          <Select
            options={[{ value: "", label: "All dtypes" }, ...dtypes.map((d) => ({ value: d, label: d }))]}
            value={dtypeFilter}
            onChange={setDtypeFilter}
            style={{ width: 200 }}
          />
        </div>

        <Card border padding={0}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0,1fr) 200px 130px 140px",
              gap: 12,
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {["Name", "Shape", "Dtype", "Bytes"].map((h) => (
              <span key={h} className="sp-eyebrow" style={{ color: "var(--text)", textAlign: h === "Bytes" ? "right" : "left" }}>
                {h}
              </span>
            ))}
          </div>
          <div
            ref={viewportRef}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            style={{ height: viewportH, overflow: "auto", position: "relative" }}
          >
            <div style={{ height: filtered.length * ROW_HEIGHT, position: "relative" }}>
              {filtered.slice(first, last).map((t, i) => {
                const idx = first + i;
                const bytes = tensorBytes(t);
                return (
                  <div
                    key={t.name}
                    style={{
                      position: "absolute",
                      top: idx * ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      display: "grid",
                      gridTemplateColumns: "minmax(0,1fr) 200px 130px 140px",
                      gap: 12,
                      alignItems: "center",
                      padding: "0 16px",
                      fontFamily: "var(--font-code)",
                      fontSize: 12,
                      background: idx % 2 ? "var(--surface)" : "transparent",
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.name}>
                      {t.name}
                    </span>
                    <span>[{t.shape.join(" × ")}]</span>
                    <span>
                      <Tag size="sm" color={isEncoded(t.dtype) ? "accent" : "ink"}>
                        {dtypeLabel(t.dtype)}
                      </Tag>
                    </span>
                    <span style={{ textAlign: "right", position: "relative" }}>
                      <span
                        aria-hidden
                        style={{
                          position: "absolute",
                          right: 0,
                          top: 6,
                          bottom: 6,
                          width: `${Math.max(1, (bytes / maxBytes) * 100)}%`,
                          background: "var(--spiral-gray-200)",
                          zIndex: 0,
                        }}
                      />
                      <span style={{ position: "relative", zIndex: 1 }}>{bytes ? formatBytes(bytes) : "—"}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        <div style={{ display: "flex", gap: 24, marginTop: 10, fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
          <span>{formatCount(filtered.length)} / {formatCount(tensors.length)} tensors</span>
          <span>{formatBytes(totalBytes)} stored total</span>
        </div>
      </div>
    </div>
  );
}

function moduleRowStyle(on: boolean): React.CSSProperties {
  return {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    padding: "5px 8px",
    fontFamily: "var(--font-code)",
    fontSize: 11,
    border: "none",
    borderLeft: `2px solid ${on ? "var(--accent)" : "transparent"}`,
    background: on ? "var(--bg)" : "none",
    cursor: "pointer",
    textAlign: "left",
    color: "var(--text)",
  };
}
