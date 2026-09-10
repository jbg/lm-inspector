import type { Readiness } from "../../lib/types";

export const READINESS_FIELDS: { key: string; label: string }[] = [
  { key: "container", label: "Container" },
  { key: "architecture_support", label: "Architecture support" },
  { key: "structural_binding", label: "Structure" },
  { key: "model_loadability", label: "Loadable" },
  { key: "requested_load", label: "Load plan" },
  { key: "text_generation", label: "Text generation" },
  { key: "tokenizer", label: "Tokenizer" },
  { key: "chat_template", label: "Chat template" },
  { key: "semantic_streaming", label: "Semantic streaming" },
  { key: "native_tools", label: "Tools" },
  { key: "multimodal", label: "Multimodal" },
];

export function ReadinessGlyph({ state }: { state: Readiness }) {
  const spec: Record<Readiness, { glyph: string; color: string; word: string }> = {
    ready: { glyph: "■", color: "var(--text)", word: "Ready" },
    missing: { glyph: "▮", color: "var(--color-text-danger)", word: "Missing" },
    unsupported: { glyph: "▮", color: "var(--color-text-danger)", word: "Unsupported" },
    invalid: { glyph: "▮", color: "var(--color-text-danger)", word: "Invalid" },
    request_dependent: { glyph: "◪", color: "var(--accent-2)", word: "Depends on request" },
    unverified: { glyph: "□", color: "var(--text-muted)", word: "Unverified" },
    not_applicable: { glyph: "—", color: "var(--text-muted)", word: "n/a" },
  };
  const s = spec[state] ?? { glyph: "?", color: "var(--text-muted)", word: String(state).replace(/_/g, " ") };
  return (
    <span style={{ color: s.color, fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 500 }}>
      {s.glyph} {s.word}
    </span>
  );
}
