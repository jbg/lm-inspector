import { useMemo, useState } from "react";
import { Tag } from "../../goose/ui";
import { formatBytes, formatDateMs } from "../../lib/format";
import type { CachedModel } from "../../lib/types";
import { useNav } from "../../state/nav";

/** One library row. Clicking anywhere opens inspection. */
export function ModelRow({ model, last }: { model: CachedModel; last?: boolean }) {
  const go = useNav((s) => s.go);
  const [hover, setHover] = useState(false);

  // Preferred revision is first (backend sorts main-ref first, then newest).
  const revision = model.revisions[0];
  const artifacts = revision?.artifacts ?? [];
  const primary = artifacts.find((a) => a.role === "model") ?? artifacts[0];

  const formats = useMemo(
    () => [...new Set(artifacts.map((a) => (a.format === "gguf" ? "GGUF" : "safetensors")))],
    [artifacts],
  );
  const open = () =>
    go({ name: "model", path: primary.path, repoId: model.repoId, tab: "overview" });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 16px",
        borderBottom: last ? "none" : "1px solid var(--color-border-primary)",
        background: hover ? "var(--color-background-secondary)" : "transparent",
        cursor: "pointer",
      }}
    >
      <div
        style={{
          minWidth: 0,
          flex: 1,
          fontWeight: 500,
          fontSize: "var(--font-text-sm-size)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {model.repoId}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flex: "none" }}>
        {formats.map((f) => (
          <Tag size="sm" key={f}>
            {f}
          </Tag>
        ))}
        {model.revisions.length > 1 && <Tag size="sm">{model.revisions.length} revisions</Tag>}
      </div>
      <span
        style={{
          fontFamily: "var(--font-code)",
          fontSize: "var(--font-text-xs-size)",
          color: "var(--color-text-secondary)",
          width: 76,
          textAlign: "right",
          flex: "none",
        }}
      >
        {formatBytes(model.sizeOnDisk)}
      </span>
      <span
        style={{
          fontSize: "var(--font-text-xs-size)",
          color: "var(--color-text-tertiary)",
          width: 116,
          textAlign: "right",
          flex: "none",
        }}
      >
        {formatDateMs(model.lastModifiedMs)}
      </span>
      <span aria-hidden style={{ color: "var(--color-text-tertiary)", flex: "none" }}>
        ›
      </span>
    </div>
  );
}
