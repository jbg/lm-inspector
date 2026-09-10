import { useEffect, useMemo } from "react";
import { Input } from "../../goose/ui";
import { Select } from "../../goose/ui";
import { Heading } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { useLibrary } from "../../state/library";
import { formatBytes, formatCount } from "../../lib/format";
import { i64ToNumber } from "../../lib/lossless";
import { ModelRow } from "./ModelCard";

export function LibraryScreen() {
  const { snapshot, loading, error, search, formatFilter, sort, refresh, setSearch, setFormatFilter, setSort } =
    useLibrary();

  useEffect(() => {
    if (!snapshot && !loading) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const models = useMemo(() => {
    // Only models with a loadable generation target are shown; incomplete
    // cache entries and assistant-only (drafter) repos are hidden — drafters
    // surface in the load form's drafter picker instead.
    let list = (snapshot?.models ?? []).filter((m) =>
      m.revisions.some((r) => r.artifacts.some((a) => a.role === "model")),
    );
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((m) => m.repoId.toLowerCase().includes(q));
    }
    if (formatFilter) {
      list = list.filter((m) =>
        m.revisions.some((r) => r.artifacts.some((a) => a.format === formatFilter)),
      );
    }
    const sorted = [...list];
    if (sort === "size") sorted.sort((a, b) => i64ToNumber(b.sizeOnDisk) - i64ToNumber(a.sizeOnDisk));
    else if (sort === "name") sorted.sort((a, b) => a.repoId.localeCompare(b.repoId, undefined, { sensitivity: "base" }));
    else sorted.sort((a, b) => i64ToNumber(b.lastModifiedMs) - i64ToNumber(a.lastModifiedMs));
    return sorted;
  }, [snapshot, search, formatFilter, sort]);

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 24 }}>
        <Heading size="md" color="ink" as="h1">
          Model library
        </Heading>
        <div style={{ flex: 1 }} />
        <Input
          placeholder="Search models"
          value={search}
          onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
          style={{ width: 280 }}
        />
        <Select
          options={[
            { value: "", label: "All formats" },
            { value: "safeTensors", label: "safetensors" },
            { value: "gguf", label: "GGUF" },
          ]}
          value={formatFilter}
          onChange={(v) => setFormatFilter(v as "" | "safeTensors" | "gguf")}
          style={{ width: 180 }}
        />
        <Select
          options={[
            { value: "recent", label: "Sort: recent" },
            { value: "size", label: "Sort: size" },
            { value: "name", label: "Sort: name" },
          ]}
          value={sort}
          onChange={(v) => setSort(v as "recent" | "size" | "name")}
          style={{ width: 180 }}
        />
      </div>

      {error && (
        <div
          style={{
            border: "1px solid var(--color-border-danger)",
            background: "var(--surface)",
            padding: 16,
            marginBottom: 24,
            fontFamily: "var(--font-code)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {loading && (
        <Eyebrow color="muted" style={{ marginBottom: 24 }}>
          Scanning cache…
        </Eyebrow>
      )}

      {!loading && models.length === 0 && !error && (
        <div style={{ textAlign: "center", padding: "96px 0" }}>
          <Heading size="lg" color="ink">
            No models in cache
          </Heading>
          <p style={{ color: "var(--text-muted)", fontFamily: "var(--font-code)", fontSize: 13 }}>
            {snapshot?.cacheDir ?? "~/.cache/huggingface/hub"}
          </p>
        </div>
      )}

      {models.length > 0 && (
        <div
          style={{
            background: "var(--color-background-primary)",
            border: "1px solid var(--color-border-primary)",
            borderRadius: "var(--border-radius-lg)",
            overflow: "hidden",
          }}
        >
          {models.map((m, i) => (
            <ModelRow key={m.repoId} model={m} last={i === models.length - 1} />
          ))}
        </div>
      )}

      {snapshot && (
        <div
          style={{
            marginTop: 32,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
            display: "flex",
            gap: 32,
            fontFamily: "var(--font-code)",
            fontSize: 12,
            color: "var(--text-muted)",
          }}
        >
          <span>{formatCount(models.length)} models</span>
          <span>{formatBytes(snapshot.totalSizeOnDisk)} on disk</span>
          <span>{snapshot.cacheDir}</span>
          {snapshot.warnings.length > 0 && (
            <span style={{ color: "var(--accent)" }}>{snapshot.warnings.length} warnings</span>
          )}
        </div>
      )}
    </div>
  );
}
