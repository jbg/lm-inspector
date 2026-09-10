import { useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { Input } from "../../goose/ui";
import type { InspectionBundle } from "../../lib/types";

export function ConfigTab({ bundle }: { bundle: InspectionBundle }) {
  const [search, setSearch] = useState("");
  const config = bundle.configuration;

  if (config === undefined || config === null) {
    return (
      <Card border padding={24}>
        <Eyebrow>Config</Eyebrow>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 13, color: "var(--text-muted)" }}>
          No config.json in this artifact (GGUF metadata carries the
          configuration; see OVERVIEW identity and issues).
        </p>
      </Card>
    );
  }

  return (
    <Card border padding={24}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 16 }}>
        <Eyebrow>
          config.json · {bundle.family} · {bundle.effectiveModelType}
        </Eyebrow>
        <div style={{ flex: 1 }} />
        <Input
          placeholder="Filter keys"
          value={search}
          onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
          style={{ width: 240 }}
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => navigator.clipboard.writeText(JSON.stringify(config, null, 2))}
        >
          Copy JSON
        </Button>
      </div>
      <div style={{ fontFamily: "var(--font-code)", fontSize: 13, lineHeight: 1.7 }}>
        <JsonNode value={config} depth={0} filter={search.toLowerCase()} />
      </div>
    </Card>
  );
}

function matches(key: string, value: unknown, filter: string): boolean {
  if (!filter) return true;
  if (key.toLowerCase().includes(filter)) return true;
  if (typeof value !== "object" || value === null) {
    return String(value).toLowerCase().includes(filter);
  }
  if (Array.isArray(value)) return value.some((v) => matches("", v, filter));
  return Object.entries(value).some(([k, v]) => matches(k, v, filter));
}

function JsonNode({ value, depth, filter }: { value: unknown; depth: number; filter: string }) {
  if (value === null) return <span style={{ color: "var(--text-muted)" }}>null</span>;
  if (typeof value === "string")
    return <span style={{ color: "var(--accent-2)" }}>"{value}"</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value)) return <JsonArray value={value} depth={depth} filter={filter} />;
  if (typeof value === "object")
    return <JsonObject value={value as Record<string, unknown>} depth={depth} filter={filter} />;
  return <span>{String(value)}</span>;
}

function JsonObject({ value, depth, filter }: { value: Record<string, unknown>; depth: number; filter: string }) {
  const [open, setOpen] = useState(depth < 2);
  const entries = Object.entries(value).filter(([k, v]) => matches(k, v, filter));
  if (entries.length === 0) return <span>{"{}"}</span>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} style={toggleStyle}>
        [+] {"{"}…{entries.length}…{"}"}
      </button>
    );
  return (
    <span>
      <button onClick={() => setOpen(false)} style={toggleStyle}>
        [−]
      </button>
      {" {"}
      <div style={{ paddingLeft: 20 }}>
        {entries.map(([k, v]) => (
          <div key={k}>
            <span style={{ fontWeight: 700 }}>{k}</span>:{" "}
            <JsonNode value={v} depth={depth + 1} filter={filter} />
          </div>
        ))}
      </div>
      {"}"}
    </span>
  );
}

function JsonArray({ value, depth, filter }: { value: unknown[]; depth: number; filter: string }) {
  const [open, setOpen] = useState(value.length <= 8);
  if (value.length === 0) return <span>[]</span>;
  if (!open)
    return (
      <button onClick={() => setOpen(true)} style={toggleStyle}>
        [+] [{value.length} items]
      </button>
    );
  return (
    <span>
      <button onClick={() => setOpen(false)} style={toggleStyle}>
        [−]
      </button>
      {" ["}
      <div style={{ paddingLeft: 20 }}>
        {value.map((v, i) => (
          <div key={i}>
            <JsonNode value={v} depth={depth + 1} filter={filter} />
            {i < value.length - 1 ? "," : ""}
          </div>
        ))}
      </div>
      {"]"}
    </span>
  );
}

const toggleStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent)",
  fontFamily: "var(--font-code)",
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
};
