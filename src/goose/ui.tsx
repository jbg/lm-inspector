// goose-idiom UI primitives for LM Inspector.
//
// The goose design system ships its 14 components only as a browser-global
// bundle carrying its own React copy (unusable inside this app's React tree),
// so per its README's conventions section these primitives are built directly
// on the shipped tokens: monochrome first, Cash Sans, hairline borders,
// rounded-md controls / rounded-lg cards, primary action = inverse surface,
// color = status only, teal #13bbaf on focus rings and small delight moments.
//
// Props stay drop-in compatible with the previous component set so screens
// migrate by import swap; visual mapping:
//   Button primary→inverse · secondary/blue→outline · ink→inverse · ghost→ghost
//   Tag/Badge → pills (accent→danger tones, blue→info, ink→neutral)
//   Eyebrow → small secondary label · StatBlock → stat tile · Toast → dark pill

import React, { useState } from "react";

const TEAL = "#13bbaf";
export const FOCUS_RING = `0 0 0 2px var(--color-background-primary), 0 0 0 4px ${TEAL}`;

type Sty = React.CSSProperties;

// ---------- Button ----------

export function Button({
  variant = "primary",
  size = "md",
  disabled = false,
  fullWidth = false,
  children,
  style,
  ...rest
}: {
  variant?: "primary" | "secondary" | "blue" | "ink" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  fullWidth?: boolean;
  children?: React.ReactNode;
  style?: Sty;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style">) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const solid = variant === "primary" || variant === "ink" || variant === "blue";
  const ghost = variant === "ghost";
  const sizes: Record<string, Sty> = {
    sm: { fontSize: "var(--font-text-xs-size)", padding: "6px 12px", minHeight: 28 },
    md: { fontSize: "var(--font-text-sm-size)", padding: "8px 16px", minHeight: 36 },
    lg: { fontSize: "var(--font-text-md-size)", padding: "10px 20px", minHeight: 44 },
  };
  const base: Sty = {
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    border: solid ? "1px solid var(--color-background-inverse)" : ghost ? "1px solid transparent" : "1px solid var(--color-border-secondary)",
    borderRadius: "var(--border-radius-md)",
    background: solid
      ? "var(--color-background-inverse)"
      : hover && !disabled
        ? "var(--color-background-secondary)"
        : "transparent",
    color: solid ? "var(--color-text-inverse)" : "var(--color-text-primary)",
    opacity: disabled ? 0.5 : solid && hover && !disabled ? 0.85 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    lineHeight: 1,
    width: fullWidth ? "100%" : undefined,
    boxShadow: focus ? FOCUS_RING : "none",
    outline: "none",
    transition: "background 120ms ease, opacity 120ms ease",
    whiteSpace: "nowrap",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      style={{ ...base, ...sizes[size], ...style }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  size = 32,
  disabled,
  style,
  ...rest
}: {
  label: string;
  children?: React.ReactNode;
  variant?: string;
  size?: number;
  disabled?: boolean;
  style?: Sty;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "style">) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--color-border-secondary)",
        borderRadius: "var(--border-radius-md)",
        background: hover && !disabled ? "var(--color-background-secondary)" : "transparent",
        color: "var(--color-text-primary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        padding: 0,
        fontFamily: "var(--font-sans)",
        fontSize: size * 0.45,
        ...style,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------- surfaces ----------

export function Card({
  children,
  inverse = false,
  padding = 20,
  border = true,
  style,
}: {
  children?: React.ReactNode;
  inverse?: boolean;
  padding?: number | string;
  border?: boolean;
  style?: Sty;
}) {
  return (
    <div
      style={{
        background: inverse ? "var(--color-background-inverse)" : "var(--color-background-primary)",
        color: inverse ? "var(--color-text-inverse)" : "var(--color-text-primary)",
        padding,
        border: border && !inverse ? "1px solid var(--color-border-primary)" : "none",
        borderRadius: "var(--border-radius-lg)",
        boxShadow: "var(--shadow-hairline)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------- text ----------

export function Heading({
  children,
  size = "lg",
  as = "h2",
  style,
}: {
  children?: React.ReactNode;
  size?: "xl" | "lg" | "md" | "sm" | string;
  color?: string;
  underline?: boolean;
  as?: "h1" | "h2" | "h3" | "div" | "span";
  style?: Sty;
}) {
  const sizes: Record<string, Sty> = {
    xl: { fontSize: "var(--font-heading-2xl-size)", lineHeight: "var(--font-heading-2xl-line-height)" },
    lg: { fontSize: "var(--font-heading-xl-size)", lineHeight: "var(--font-heading-xl-line-height)" },
    md: { fontSize: "var(--font-heading-lg-size)", lineHeight: "var(--font-heading-lg-line-height)" },
    sm: { fontSize: "var(--font-heading-md-size)", lineHeight: "var(--font-heading-md-line-height)" },
  };
  const Tag = as;
  return (
    <Tag
      style={{
        fontFamily: "var(--font-sans)",
        fontWeight: 500,
        color: "inherit",
        margin: 0,
        textTransform: "none",
        letterSpacing: "-0.01em",
        ...(sizes[size] ?? { fontSize: size }),
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

/** Small section label (replaces the uppercase eyebrow — goose is sentence
 * case, so this just renders quiet secondary text at xs). */
export function Eyebrow({
  children,
  color,
  style,
}: {
  children?: React.ReactNode;
  color?: "accent" | "blue" | "ink" | "muted" | string;
  style?: Sty;
}) {
  const c =
    color === "blue"
      ? "var(--color-text-info)"
      : color === "accent"
        ? "var(--color-text-primary)"
        : "var(--color-text-secondary)";
  return (
    <div
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-text-xs-size)",
        fontWeight: 500,
        color: c,
        textTransform: "none",
        letterSpacing: 0,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ---------- pills ----------

function pillColors(color: string | undefined, filled: boolean): Sty {
  const map: Record<string, { fg: string; bg: string }> = {
    accent: { fg: "var(--color-text-danger)", bg: "var(--color-background-danger)" },
    blue: { fg: "var(--color-text-info)", bg: "var(--color-background-info)" },
    ink: { fg: "var(--color-text-primary)", bg: "var(--color-background-inverse)" },
  };
  const c = map[color ?? "ink"] ?? map.ink;
  if (filled) return { background: c.bg, color: "#fff", border: "1px solid transparent" };
  return {
    background: "var(--color-background-secondary)",
    color: c.fg,
    border: "1px solid var(--color-border-primary)",
  };
}

export function Tag({
  children,
  color = "ink",
  filled = false,
  size = "md",
  onClick,
  style,
}: {
  children?: React.ReactNode;
  color?: "accent" | "blue" | "ink" | string;
  filled?: boolean;
  size?: "sm" | "md";
  onClick?: () => void;
  style?: Sty;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: "var(--border-radius-full)",
        fontFamily: "var(--font-sans)",
        fontSize: size === "sm" ? 11 : "var(--font-text-xs-size)",
        fontWeight: 500,
        padding: size === "sm" ? "2px 8px" : "4px 10px",
        lineHeight: 1.3,
        cursor: onClick ? "pointer" : "default",
        whiteSpace: "nowrap",
        ...pillColors(color, filled),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function Badge({
  children,
  color = "ink",
  style,
}: {
  children?: React.ReactNode;
  color?: string;
  style?: Sty;
}) {
  return <Tag color={color === "gray" ? "ink" : color} filled style={style}>{children}</Tag>;
}

// ---------- form controls ----------

export function Input({
  label,
  hint,
  error,
  prefix,
  style,
  inputStyle,
  ...rest
}: {
  label?: string;
  hint?: string;
  error?: string;
  prefix?: React.ReactNode;
  style?: Sty;
  inputStyle?: Sty;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "style" | "prefix">) {
  const [focus, setFocus] = useState(false);
  const borderColor = error
    ? "var(--color-border-danger)"
    : "var(--color-border-secondary)";
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-sans)", ...style }}>
      {label && (
        <span style={{ fontSize: "var(--font-text-xs-size)", fontWeight: 500, color: "var(--color-text-secondary)" }}>
          {label}
        </span>
      )}
      <span
        style={{
          display: "flex",
          alignItems: "center",
          border: `1px solid ${borderColor}`,
          borderRadius: "var(--border-radius-md)",
          background: "var(--color-background-primary)",
          minHeight: 36,
          boxShadow: focus ? FOCUS_RING : "none",
          transition: "box-shadow 120ms ease",
        }}
      >
        {prefix && (
          <span style={{ padding: "0 8px", color: "var(--color-text-tertiary)", fontSize: "var(--font-text-sm-size)" }}>
            {prefix}
          </span>
        )}
        <input
          {...rest}
          onFocus={(e) => {
            setFocus(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocus(false);
            rest.onBlur?.(e);
          }}
          style={{
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 0,
            background: "transparent",
            padding: "7px 10px",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-text-sm-size)",
            color: "var(--color-text-primary)",
            ...inputStyle,
          }}
        />
      </span>
      {(error || hint) && (
        <span style={{ fontSize: "var(--font-text-xs-size)", color: error ? "var(--color-text-danger)" : "var(--color-text-tertiary)" }}>
          {error || hint}
        </span>
      )}
    </label>
  );
}

export function Select({
  label,
  options = [],
  value,
  onChange,
  placeholder,
  style,
  ...rest
}: {
  label?: string;
  options?: Array<string | { value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  style?: Sty;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "style" | "onChange" | "value">) {
  const [focus, setFocus] = useState(false);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-sans)", ...style }}>
      {label && (
        <span style={{ fontSize: "var(--font-text-xs-size)", fontWeight: 500, color: "var(--color-text-secondary)" }}>
          {label}
        </span>
      )}
      <span
        style={{
          position: "relative",
          display: "flex",
          border: "1px solid var(--color-border-secondary)",
          borderRadius: "var(--border-radius-md)",
          background: "var(--color-background-primary)",
          minHeight: 36,
          boxShadow: focus ? FOCUS_RING : "none",
          transition: "box-shadow 120ms ease",
        }}
      >
        <select
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            appearance: "none",
            WebkitAppearance: "none",
            flex: 1,
            minWidth: 0,
            border: 0,
            outline: 0,
            background: "transparent",
            padding: "7px 28px 7px 10px",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-text-sm-size)",
            color: "var(--color-text-primary)",
            cursor: "pointer",
          }}
          {...rest}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((o) =>
            typeof o === "string" ? (
              <option key={o} value={o}>
                {o}
              </option>
            ) : (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ),
          )}
        </select>
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: 10,
            top: 0,
            bottom: 0,
            display: "flex",
            alignItems: "center",
            color: "var(--color-text-tertiary)",
            pointerEvents: "none",
            fontSize: 11,
          }}
        >
          ▾
        </span>
      </span>
    </label>
  );
}

export function Checkbox({
  checked = false,
  onChange,
  label,
  disabled = false,
  style,
}: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  style?: Sty;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-text-sm-size)",
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: "var(--border-radius-sm)",
          border: `1px solid ${checked ? "var(--color-background-inverse)" : "var(--color-border-secondary)"}`,
          background: checked ? "var(--color-background-inverse)" : "var(--color-background-primary)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
          color: "var(--color-text-inverse)",
          fontSize: 11,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function Radio({
  name,
  value,
  checked = false,
  onChange,
  label,
  disabled = false,
  title,
  style,
}: {
  name?: string;
  value: string;
  checked?: boolean;
  onChange?: (value: string) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  title?: string;
  style?: Sty;
}) {
  return (
    <label
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-text-sm-size)",
        ...style,
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange?.(value)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: "var(--border-radius-full)",
          border: `1px solid ${checked ? "var(--color-background-inverse)" : "var(--color-border-secondary)"}`,
          background: "var(--color-background-primary)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "none",
        }}
      >
        {checked && (
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-background-inverse)", display: "block" }} />
        )}
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

export function RadioGroup({
  name,
  options = [],
  value,
  onChange,
  direction = "column",
  style,
}: {
  name?: string;
  options?: Array<string | { value: string; label: string; disabled?: boolean; title?: string }>;
  value?: string;
  onChange?: (value: string) => void;
  direction?: "column" | "row";
  style?: Sty;
}) {
  return (
    <div role="radiogroup" style={{ display: "flex", flexDirection: direction, gap: direction === "column" ? 8 : 20, ...style }}>
      {options.map((o) => {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        const disabled = typeof o === "string" ? false : (o.disabled ?? false);
        const title = typeof o === "string" ? undefined : o.title;
        return (
          <Radio
            key={v}
            name={name}
            value={v}
            label={l}
            checked={value === v}
            onChange={onChange}
            disabled={disabled}
            title={title}
          />
        );
      })}
    </div>
  );
}

export function Switch({
  checked = false,
  onChange,
  label,
  disabled = false,
  style,
}: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  style?: Sty;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-text-sm-size)",
        ...style,
      }}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <span
        aria-hidden
        style={{
          width: 34,
          height: 20,
          borderRadius: "var(--border-radius-full)",
          background: checked ? "var(--color-background-inverse)" : "var(--color-background-tertiary)",
          position: "relative",
          flex: "none",
          transition: "background 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 16 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--color-background-primary)",
            boxShadow: "var(--shadow-sm)",
            transition: "left 120ms ease",
          }}
        />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

// ---------- navigation ----------

export function Tabs({
  items = [],
  value,
  onChange,
  style,
}: {
  items?: Array<string | { value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
  style?: Sty;
}) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 20, borderBottom: "1px solid var(--color-border-primary)", ...style }}>
      {items.map((it) => {
        const v = typeof it === "string" ? it : it.value;
        const l = typeof it === "string" ? it : it.label;
        const on = v === value;
        return (
          <button
            key={v}
            role="tab"
            aria-selected={on}
            onClick={() => onChange?.(v)}
            style={{
              background: "none",
              border: 0,
              borderBottom: `2px solid ${on ? "var(--color-background-inverse)" : "transparent"}`,
              marginBottom: -1,
              padding: "6px 2px 10px",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-text-sm-size)",
              fontWeight: 500,
              color: on ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            }}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

// ---------- data display ----------

export function BulletList({
  items = [],
  numbered = false,
  size = 14,
  gap = 10,
  style,
}: {
  items?: React.ReactNode[];
  color?: string;
  numbered?: boolean;
  size?: number;
  gap?: number;
  style?: Sty;
}) {
  return (
    <ul
      style={{
        listStyle: numbered ? "decimal" : "disc",
        margin: 0,
        paddingLeft: 20,
        display: "flex",
        flexDirection: "column",
        gap,
        fontFamily: "var(--font-sans)",
        fontSize: size,
        color: "var(--color-text-primary)",
        ...style,
      }}
    >
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Stat tile: quiet label over a large number, on a secondary surface. */
export function StatBlock({
  value,
  caption,
  label,
  size = 96,
  style,
}: {
  value?: React.ReactNode;
  caption?: React.ReactNode;
  label?: string;
  tone?: string;
  size?: number;
  style?: Sty;
}) {
  return (
    <div
      style={{
        minWidth: size,
        background: "var(--color-background-secondary)",
        borderRadius: "var(--border-radius-lg)",
        padding: "12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        fontFamily: "var(--font-sans)",
        ...style,
      }}
    >
      {label && (
        <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-secondary)", fontWeight: 500 }}>
          {label}
        </span>
      )}
      <span style={{ fontSize: "var(--font-heading-md-size)", fontWeight: 500, color: "var(--color-text-primary)" }}>
        {value}
      </span>
      {caption && (
        <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-tertiary)" }}>{caption}</span>
      )}
    </div>
  );
}

// ---------- feedback ----------

export function Tooltip({
  label,
  children,
  side = "top",
}: {
  label: React.ReactNode;
  children?: React.ReactNode;
  side?: "top" | "bottom";
}) {
  const [on, setOn] = useState(false);
  const pos: Sty =
    side === "bottom"
      ? { top: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" }
      : { bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)" };
  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setOn(true)}
      onMouseLeave={() => setOn(false)}
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
    >
      {children}
      {on && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            ...pos,
            background: "var(--color-background-inverse)",
            color: "var(--color-text-inverse)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--font-text-xs-size)",
            padding: "4px 8px",
            borderRadius: "var(--border-radius-sm)",
            whiteSpace: "nowrap",
            zIndex: 10,
            boxShadow: "var(--shadow-md)",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export function Dialog({
  open = false,
  title,
  children,
  actions,
  onClose,
  width = 480,
}: {
  open?: boolean;
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
  width?: number;
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: width,
          background: "var(--color-background-primary)",
          color: "var(--color-text-primary)",
          fontFamily: "var(--font-sans)",
          borderRadius: "var(--border-radius-xl)",
          boxShadow: "var(--shadow-lg)",
          padding: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontSize: "var(--font-heading-sm-size)", fontWeight: 500 }}>{title}</span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: 0,
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
                padding: 4,
              }}
            >
              ×
            </button>
          )}
        </div>
        <div style={{ fontSize: "var(--font-text-sm-size)", lineHeight: 1.55, color: "var(--color-text-primary)" }}>
          {children}
        </div>
        {actions && <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>{actions}</div>}
      </div>
    </div>
  );
}

export function Toast({
  children,
  tone = "ink",
  onDismiss,
  style,
}: {
  children?: React.ReactNode;
  tone?: "ink" | "accent" | "blue" | "success" | string;
  onDismiss?: () => void;
  style?: Sty;
}) {
  const bg =
    tone === "accent"
      ? "var(--color-background-danger)"
      : tone === "blue"
        ? "var(--color-background-info)"
        : tone === "success"
          ? "var(--color-background-success)"
          : "var(--color-background-inverse)";
  const fg = tone === "ink" ? "var(--color-text-inverse)" : "#fff";
  return (
    <div
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        background: bg,
        color: fg,
        padding: "10px 14px",
        borderRadius: "var(--border-radius-lg)",
        boxShadow: "var(--shadow-lg)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-text-sm-size)",
        maxWidth: 420,
        ...style,
      }}
    >
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          style={{ background: "none", border: 0, color: fg, cursor: "pointer", fontSize: 14, padding: 0 }}
        >
          ×
        </button>
      )}
    </div>
  );
}
