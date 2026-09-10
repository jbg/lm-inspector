// Token text rendering rules: tokens are always text, whitespace made visible.
//   space -> "␣"  newline -> "⏎"  tab -> "⇥"  other control/unprintable -> ⟨u+XXXX⟩

export interface TokenGlyphSegment {
  text: string;
  glyph: boolean;
}

export function tokenSegments(piece: string): TokenGlyphSegment[] {
  const segments: TokenGlyphSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      segments.push({ text: plain, glyph: false });
      plain = "";
    }
  };
  for (const ch of piece) {
    if (ch === " ") {
      flush();
      segments.push({ text: "␣", glyph: true });
    } else if (ch === "\n") {
      flush();
      segments.push({ text: "⏎", glyph: true });
    } else if (ch === "\t") {
      flush();
      segments.push({ text: "⇥", glyph: true });
    } else if (ch.charCodeAt(0) < 0x20 || ch === "\u{fffd}") {
      flush();
      const code = ch.codePointAt(0) ?? 0;
      segments.push({ text: `⟨u+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`, glyph: true });
    } else {
      plain += ch;
    }
  }
  flush();
  if (segments.length === 0) segments.push({ text: "∅", glyph: true });
  return segments;
}

/** Whether the token piece ends with a newline (tape inserts a line break). */
export function endsWithNewline(piece: string): boolean {
  return piece.endsWith("\n");
}
