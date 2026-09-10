// The single shared token renderer: tokens are always text, whitespace made
// visible with glyphs. Used by the tape, alternates, vocab search, tokenize
// sandbox, comparisons, and the speculation lane.

import { memo } from "react";
import { tokenSegments } from "../../lib/tokenText";

export interface TokenCellProps {
  piece: string;
  selected?: boolean;
  forced?: boolean;
  speculative?: boolean;
  replay?: boolean;
  muted?: boolean;
  /** Top-2 candidates were nearly tied at this decision. */
  closeCall?: boolean;
  /** The sampler picked a non-argmax candidate (temperature dice roll). */
  offTop?: boolean;
  /** Known-forbidden by the decision's tokenizer/grammar domain. */
  forbidden?: boolean;
  title?: string;
  onClick?: () => void;
}

export const TokenCell = memo(function TokenCell({
  piece,
  selected,
  forced,
  speculative,
  replay,
  muted,
  closeCall,
  offTop,
  forbidden,
  title,
  onClick,
}: TokenCellProps) {
  const segments = tokenSegments(piece);
  return (
    <button
      type="button"
      className="tok"
      data-selected={selected || undefined}
      data-forced={forced || undefined}
      data-spec={speculative || undefined}
      data-replay={replay || undefined}
      data-muted={muted || undefined}
      data-close={closeCall || undefined}
      data-offtop={offTop || undefined}
      data-forbidden={forbidden || undefined}
      title={title}
      onClick={onClick}
      tabIndex={onClick ? 0 : -1}
    >
      {segments.map((s, i) =>
        s.glyph ? (
          <span key={i} className="glyph">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </button>
  );
});
