import { useEffect, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { tokenizePreview } from "../../lib/ipc";
import { ipcErrorMessage, type InspectionBundle, type Readiness, type TokenPiece } from "../../lib/types";
import { TokenCell } from "../common/TokenCell";
import { ReadinessGlyph } from "./readiness";

const TEXT_FIELDS: { key: string; label: string }[] = [
  { key: "tokenizer", label: "Tokenizer" },
  { key: "chat_template", label: "Chat template" },
  { key: "semantic_streaming", label: "Semantic streaming" },
  { key: "native_tools", label: "Native tools" },
  { key: "text_generation", label: "Text generation" },
];

export function TokenizerTab({ bundle, path }: { bundle: InspectionBundle; path: string }) {
  const r = bundle.report;
  const [text, setText] = useState("The quick brown fox jumps over the lazy dog.");
  const [pieces, setPieces] = useState<TokenPiece[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (!text) {
        setPieces([]);
        return;
      }
      setBusy(true);
      try {
        const result = await tokenizePreview(path, text);
        if (!cancelled) {
          setPieces(result);
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) setError(ipcErrorMessage(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [text, path]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
      <Card border padding={24}>
        <Eyebrow style={{ marginBottom: 14 }}>Text readiness</Eyebrow>
        {TEXT_FIELDS.map((f) => (
          <div
            key={f.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--spiral-gray-200)",
              padding: "6px 0",
            }}
          >
            <span className="sp-eyebrow" style={{ color: "var(--text)" }}>
              {f.label}
            </span>
            <ReadinessGlyph state={(r[f.key] as Readiness) ?? "unverified"} />
          </div>
        ))}
      </Card>

      <Card border padding={24}>
        <Eyebrow style={{ marginBottom: 14 }}>Tokenize sandbox</Eyebrow>
        <Input
          label="Text"
          value={text}
          onChange={(e) => setText((e.target as HTMLInputElement).value)}
          hint={busy ? "tokenizing…" : pieces.length ? `${pieces.length} tokens` : undefined}
          error={error}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 16, lineHeight: 2 }}>
          {pieces.map((p, i) => (
            <span key={i} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
              <TokenCell piece={p.text} />
              <span style={{ fontFamily: "var(--font-code)", fontSize: 9, color: "var(--text-muted)" }}>
                {p.id}
              </span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
