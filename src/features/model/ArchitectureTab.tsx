import { useMemo, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { UNKNOWN } from "../../lib/format";
import type {
  ArchitectureDescriptor,
  ArchitectureNode,
  InspectionBundle,
  ObservationPoint,
} from "../../lib/types";
import { scalarValue } from "../../lib/types";

// ----- helpers over the descriptor -----

function nodeMap(arch: ArchitectureDescriptor): Map<string, ArchitectureNode> {
  return new Map(arch.nodes.map((n) => [n.id, n]));
}

/** All descendant nodes (children, grandchildren, ...) of a node id. */
function descendants(arch: ArchitectureDescriptor, id: string): ArchitectureNode[] {
  const out: ArchitectureNode[] = [];
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of arch.nodes) {
      if (n.parent === cur) {
        out.push(n);
        queue.push(n.id);
      }
    }
  }
  return out;
}

export interface CellInfo {
  attn?: "full" | "sliding" | "local";
  window?: number;
  mixer?: string;
  moe: boolean;
  title: string;
}

/** Classify a decoder execution for the layer strip. */
function classifyExecution(arch: ArchitectureDescriptor, nodeId: string): CellInfo {
  const kids = descendants(arch, nodeId);
  const attn = kids.find((k) => k.kind === "attention");
  const mixer = kids.find((k) => k.kind === "mixer");
  const moe = kids.some((k) => k.kind === "mixture_of_experts");
  const info: CellInfo = { moe, title: "decoder block" };
  if (attn) {
    const rf = attn.attention?.receptive_field as { kind?: string; window?: number } | string | undefined;
    const rfKind = typeof rf === "string" ? rf : rf?.kind;
    if (rfKind === "sliding" || rfKind === "local") {
      info.attn = rfKind;
      info.window = typeof rf === "object" ? rf?.window : undefined;
      info.title = `sliding-window attention${info.window ? ` (${info.window})` : ""}`;
    } else {
      info.attn = "full";
      info.title = "full attention";
    }
  } else if (mixer) {
    info.mixer = mixer.mixer?.mechanism ?? "recurrent";
    info.title = `mixer (${info.mixer})`;
  }
  if (moe) info.title += " + mixture of experts";
  return info;
}

function completenessLabel(c: unknown): { text: string; reasons: string[] } {
  if (c && typeof c === "object") {
    const o = c as { status?: string; reasons?: string[] };
    if (o.status === "complete") return { text: "Complete", reasons: [] };
    if (o.status === "partial") return { text: "Partial", reasons: o.reasons ?? [] };
    if (o.status === "unsupported") return { text: "Unsupported", reasons: o.reasons ?? [] };
  }
  return { text: UNKNOWN, reasons: [] };
}

// ----- flow diagram pieces -----

/** One layer as a patterned cell: fill = full attention, diagonal half-fill =
 * sliding window, stripes = mixer/recurrent, teal dot = mixture of experts. */
function LayerCell({
  info,
  selected,
  onClick,
  title,
  size = 20,
}: {
  info: CellInfo;
  selected: boolean;
  onClick?: () => void;
  title?: string;
  size?: number;
}) {
  const ink = "var(--color-text-primary)";
  return (
    <button
      onClick={onClick}
      title={title}
      style={{ background: "none", border: "none", padding: 0, cursor: onClick ? "pointer" : "default", lineHeight: 0 }}
    >
      <svg className="viz" width={size} height={size}>
        <rect
          x={1}
          y={1}
          width={size - 2}
          height={size - 2}
          rx={3}
          fill={info.attn === "full" ? ink : "var(--color-background-primary)"}
          stroke={selected ? "var(--accent)" : "var(--color-border-secondary)"}
          strokeWidth={selected ? 2 : 1}
        />
        {(info.attn === "sliding" || info.attn === "local") && (
          <path d={`M 1 ${size - 1} L ${size - 1} ${size - 1} L ${size - 1} 1 Z`} fill={ink} />
        )}
        {info.mixer && (
          <>
            <rect x={4} y={size * 0.3} width={size - 8} height={2} fill={ink} />
            <rect x={4} y={size * 0.55} width={size - 8} height={2} fill={ink} />
          </>
        )}
        {info.moe && <circle cx={size - 5} cy={5} r={3} fill="var(--accent)" stroke="var(--color-background-primary)" strokeWidth={1} />}
      </svg>
    </button>
  );
}

/** Downward data-flow connector between stack stages. */
function Connector({ label }: { label?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "2px 0" }}>
      {label && (
        <span style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--color-text-tertiary)" }}>
          {label}
        </span>
      )}
      <svg className="viz" width={12} height={label ? 14 : 20}>
        <line x1={6} y1={0} x2={6} y2={label ? 8 : 14} stroke="var(--color-text-tertiary)" strokeWidth={1} />
        <path d={`M 2 ${label ? 8 : 14} L 6 ${label ? 13 : 19} L 10 ${label ? 8 : 14}`} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={1} />
      </svg>
    </div>
  );
}

function SpineNode({
  node,
  selected,
  onSelect,
}: {
  node: ArchitectureNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const axes = node.output_axes?.map((a) => a.name).join(" × ");
  return (
    <button
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        border: "1px solid var(--color-border-primary)",
        boxShadow: selected ? "0 0 0 2px var(--accent)" : "var(--shadow-hairline)",
        borderRadius: "var(--border-radius-lg)",
        background: "var(--color-background-primary)",
        padding: "12px 18px",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span style={{ fontWeight: 500, fontSize: "var(--font-text-sm-size)", color: "var(--text)" }}>
        {KIND_LABELS[node.kind] ?? node.kind}
      </span>
      <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
        {node.label}
        {axes ? ` · [${axes}]` : ""}
      </span>
    </button>
  );
}

function GroupBand({
  group,
  arch,
  selected,
  onSelect,
}: {
  group: ArchitectureDescriptor["layer_groups"][number];
  arch: ArchitectureDescriptor;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const shared = group.weight_sharing === "shared_across_passes";
  const multiPass = group.passes.length > 1;
  // Shared-weight groups show ONE strip of physical layers — the repetition
  // is carried by the loop rail alone. The pass chips pick which execution
  // (capture identity) a cell click targets.
  const collapse = shared && multiPass;
  const [passIndex, setPassIndex] = useState(0);
  const visiblePasses = collapse ? [group.passes[passIndex]] : group.passes;

  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 0 }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: "1px solid var(--color-border-primary)",
          borderRadius: "var(--border-radius-lg)",
          background: "var(--color-background-primary)",
          boxShadow: "var(--shadow-hairline)",
          padding: "14px 18px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 500, fontSize: "var(--font-text-sm-size)" }}>{group.label}</span>
          <span className="sp-eyebrow">
            {group.physical_layer_count} layers
            {multiPass ? ` × ${group.passes.length} passes` : ""}
          </span>
          {collapse && (
            <span style={{ display: "inline-flex", gap: 4, marginLeft: "auto" }}>
              {group.passes.map((p) => (
                <button
                  key={p.index}
                  onClick={() => setPassIndex(p.index)}
                  title="which pass a layer click inspects — same weights, separate capture paths"
                  style={{
                    border: "1px solid var(--color-border-secondary)",
                    borderRadius: "var(--border-radius-full)",
                    background: passIndex === p.index ? "var(--color-background-inverse)" : "transparent",
                    color: passIndex === p.index ? "var(--color-text-inverse)" : "var(--color-text-secondary)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    fontWeight: 500,
                    padding: "2px 10px",
                    cursor: "pointer",
                  }}
                >
                  pass {p.index + 1}
                </button>
              ))}
            </span>
          )}
        </div>
        {visiblePasses.map((pass) => (
          <div key={pass.index} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            {!collapse && multiPass && (
              <span className="sp-eyebrow" style={{ color: "var(--color-text-tertiary)", width: 76, flex: "none" }}>
                pass {pass.index + 1}
              </span>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
              {pass.executions.map((exec) => {
                const info = classifyExecution(arch, exec.node_id);
                return (
                  <LayerCell
                    key={exec.node_id}
                    info={info}
                    selected={selected === exec.node_id}
                    onClick={() => onSelect(exec.node_id)}
                    title={`layer ${exec.physical_layer_index + 1}${multiPass ? ` · pass ${pass.index + 1}` : ""} — ${info.title}`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <RibbonLegend arch={arch} group={group} />
      </div>
      {collapse && <LoopRail passes={group.passes.length} />}
    </div>
  );
}

/** Loop-back rail: the same physical weights are traversed again — data exits
 * the stack bottom and re-enters at the top. */
function LoopRail({ passes }: { passes: number }) {
  return (
    <div
      aria-hidden
      style={{
        width: 46,
        flex: "none",
        alignSelf: "stretch",
        margin: "16px 0 16px 6px",
        borderTop: "1px solid var(--color-text-tertiary)",
        borderRight: "1px solid var(--color-text-tertiary)",
        borderBottom: "1px solid var(--color-text-tertiary)",
        borderRadius: "0 12px 12px 0",
        position: "relative",
      }}
      title={`${passes} passes over the same weights`}
    >
      <span style={{ position: "absolute", top: -7, left: -4, color: "var(--color-text-tertiary)", fontSize: 10, lineHeight: 1 }}>
        ◀
      </span>
      <span
        style={{
          position: "absolute",
          top: "50%",
          right: -8,
          transform: "translateY(-50%)",
          writingMode: "vertical-rl",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 500,
          color: "var(--color-text-secondary)",
          background: "var(--bg)",
          padding: "6px 0",
        }}
      >
        ×{passes} same weights
      </span>
    </div>
  );
}

const LEGEND_SAMPLES: { key: string; info: CellInfo; label: (w?: number) => string }[] = [
  { key: "full", info: { attn: "full", moe: false, title: "" }, label: () => "full attention" },
  { key: "sliding", info: { attn: "sliding", moe: false, title: "" }, label: (w) => `sliding window${w ? ` (${w})` : ""}` },
  { key: "mixer", info: { mixer: "m", moe: false, title: "" }, label: () => "mixer / recurrent" },
  { key: "moe", info: { moe: true, title: "" }, label: () => "mixture of experts" },
];

function RibbonLegend({
  arch,
  group,
}: {
  arch: ArchitectureDescriptor;
  group: ArchitectureDescriptor["layer_groups"][number];
}) {
  const present = new Set<string>();
  let window: number | undefined;
  for (const p of group.passes)
    for (const e of p.executions) {
      const c = classifyExecution(arch, e.node_id);
      if (c.attn === "full") present.add("full");
      if (c.attn === "sliding" || c.attn === "local") {
        present.add("sliding");
        window = c.window ?? window;
      }
      if (c.mixer) present.add("mixer");
      if (c.moe) present.add("moe");
    }
  if (present.size <= 1) return null;
  return (
    <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
      {LEGEND_SAMPLES.filter((l) => present.has(l.key)).map((l) => (
        <span key={l.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <LayerCell info={l.info} selected={false} size={14} />
          <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-secondary)" }}>
            {l.label(l.key === "sliding" ? window : undefined)}
          </span>
        </span>
      ))}
    </div>
  );
}

const KIND_LABELS: Record<string, string> = {
  embedding: "Embedding",
  decoder_block: "Decoder block",
  normalization: "Norm",
  attention: "Attention",
  mixer: "Mixer",
  feed_forward: "Feed forward",
  mixture_of_experts: "Mixture of experts",
  router: "Router",
  routed_experts: "Routed experts",
  shared_experts: "Shared experts",
  residual_add: "Residual add",
  sum: "Sum",
  output_head: "LM head",
  processor: "Processor",
  encoder: "Encoder",
  projector: "Projector",
  modality_merge: "Modality merge",
  prediction: "Prediction",
  realtime: "Realtime",
  opaque: "Opaque",
};

// ----- component -----

export function ArchitectureTab({ bundle }: { bundle: InspectionBundle }) {
  const arch = bundle.architecture;
  const [selected, setSelected] = useState<string | null>(null);

  const nodes = useMemo(() => nodeMap(arch), [arch]);
  const groupMemberIds = useMemo(() => {
    const s = new Set<string>();
    for (const g of arch.layer_groups)
      for (const p of g.passes) for (const e of p.executions) s.add(e.node_id);
    return s;
  }, [arch]);

  // Top-level spine rows: parentless nodes not owned by a layer group, in
  // descriptor order, with the group band spliced in at the first member.
  const spine = useMemo(() => {
    const rows: Array<{ kind: "node"; node: ArchitectureNode } | { kind: "groups" }> = [];
    let groupsInserted = false;
    for (const n of arch.nodes) {
      if (n.parent) continue;
      if (groupMemberIds.has(n.id)) {
        if (!groupsInserted) {
          rows.push({ kind: "groups" });
          groupsInserted = true;
        }
        continue;
      }
      rows.push({ kind: "node", node: n });
    }
    if (!groupsInserted && arch.layer_groups.length > 0) rows.push({ kind: "groups" });
    return rows;
  }, [arch, groupMemberIds]);

  const completeness = completenessLabel(arch.completeness);
  const selectedNode = selected ? nodes.get(selected) : undefined;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 20, alignItems: "start" }}>
      <div>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          <Connector label="tokens" />
          {spine.map((row, i) => (
            <div key={row.kind === "node" ? row.node.id : `groups-${i}`}>
              {i > 0 && <Connector />}
              {row.kind === "node" ? (
                <SpineNode
                  node={row.node}
                  selected={selected === row.node.id}
                  onSelect={() => setSelected(row.node.id)}
                />
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                  {arch.layer_groups.map((g, gi) => (
                    <div key={g.id}>
                      {gi > 0 && <Connector />}
                      <GroupBand group={g} arch={arch} selected={selected} onSelect={setSelected} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          <Connector label="logits" />
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16 }}>
          <Eyebrow color="muted">Description</Eyebrow>
          <Tag size="sm" color={completeness.text === "Complete" ? "ink" : "accent"}>
            {completeness.text}
          </Tag>
          {completeness.reasons.map((r, i) => (
            <span key={i} style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
              {r}
            </span>
          ))}
        </div>

        <ComponentSummary arch={arch} />

        {arch.parameter_groups.some((p) => p.shared_with) && (
          <Card border padding={16} style={{ marginTop: 12 }}>
            <Eyebrow style={{ marginBottom: 10 }}>Parameter sharing</Eyebrow>
            {arch.parameter_groups
              .filter((p) => p.shared_with)
              .map((p) => (
                <div key={p.id} style={{ fontFamily: "var(--font-code)", fontSize: 12, padding: "2px 0" }}>
                  {p.canonical_prefix} <span style={{ color: "var(--accent)" }}>⇢</span> {p.shared_with}
                </div>
              ))}
          </Card>
        )}
      </div>

      <DetailPanel arch={arch} node={selectedNode} bundle={bundle} />
    </div>
  );
}

// ----- component topology (architecture schema ≥ 13) -----

/** Cold summary of the scalar component declarations: what the component
 * analysis workflow can decompose, before any weights are loaded. A missing
 * declaration means "not described", never "no components". */
function ComponentSummary({ arch }: { arch: ArchitectureDescriptor }) {
  const groups = arch.components ?? [];
  const readout = arch.component_readout;
  if (groups.length === 0 && !readout) return null;
  const total = groups.reduce((a, g) => a + g.count, 0);
  const kinds = new Map<string, number>();
  for (const g of groups) {
    const kind = g.activation_equation?.kind ?? "unknown";
    kinds.set(kind, (kinds.get(kind) ?? 0) + g.count);
  }
  const transform = readout?.output_transform?.kind;
  return (
    <Card border padding={16} style={{ marginTop: 12 }}>
      <Eyebrow style={{ marginBottom: 10 }}>Component analysis</Eyebrow>
      <div style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>
        {total.toLocaleString()} scalar components in {groups.length} groups
        {kinds.size > 0 &&
          ` · ${[...kinds.entries()].map(([k, n]) => `${n.toLocaleString()} ${k}`).join(" · ")}`}
      </div>
      {readout && (
        <div style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          readout: {readout.normalization?.kind} norm → {readout.weight}
          {readout.tied_embeddings ? " (tied embeddings)" : ""}
          {transform && transform !== "identity" ? ` → ${transform}` : ""}
          {(readout.other_writes?.length ?? 0) > 0 &&
            ` · ${readout.other_writes?.length} whole residual writes`}
          {(readout.block_transforms?.length ?? 0) > 0 &&
            ` · whole-residual transforms declared`}
        </div>
      )}
      <div style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        declarations are cold facts — loaded capture/intervention/parameter
        support is checked when the model is loaded
      </div>
    </Card>
  );
}

/** Component groups declared at (or under) the selected node. */
function ComponentGroupRows({ arch, nodeIds }: { arch: ArchitectureDescriptor; nodeIds: Set<string> }) {
  const groups = (arch.components ?? []).filter((g) => nodeIds.has(g.node_id));
  if (groups.length === 0) return null;
  return (
    <>
      <Eyebrow style={{ margin: "14px 0 6px" }}>Components ({groups.length} groups)</Eyebrow>
      {groups.map((g) => (
        <div key={g.id} style={{ fontFamily: "var(--font-code)", fontSize: 11, padding: "3px 0" }}>
          <div style={{ wordBreak: "break-all" }}>{g.id}</div>
          <div style={{ color: "var(--text-muted)" }}>
            {g.count.toLocaleString()} × {g.activation_equation?.kind ?? "unknown"}
            {" · "}
            {g.reads.map((r) => r.role).join("+") || "no reads"} → write
            {g.write_bias ? " + bias" : ""}
            {g.output_normalization ? " → norm" : ""}
            {scalarValue(g.residual_scale) !== 1 && Number.isFinite(scalarValue(g.residual_scale))
              ? ` · ×${scalarValue(g.residual_scale)}`
              : ""}
          </div>
        </div>
      ))}
    </>
  );
}

// ----- detail panel -----

function DetailPanel({
  arch,
  node,
  bundle,
}: {
  arch: ArchitectureDescriptor;
  node?: ArchitectureNode;
  bundle: InspectionBundle;
}) {
  const points = (bundle.architecture.observations?.points ?? []) as ObservationPoint[];
  if (!node) {
    return (
      <Card border padding={24}>
        <Eyebrow style={{ marginBottom: 12 }}>Detail</Eyebrow>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
          Select a layer cell or spine block to see its attributes, contained
          operations, and observation points.
        </p>
      </Card>
    );
  }
  const kids = descendants(arch, node.id);
  const interesting = [node, ...kids];
  const nodePaths = new Set(interesting.flatMap((n) => n.observation_paths));
  const nodePoints = points.filter((p) => nodePaths.has(p.path));
  const comp = completenessLabel(node.completeness);
  const edges = arch.edges.filter(
    (e) =>
      e.from === node.id ||
      e.to === node.id ||
      kids.some((k) => k.id === e.from || k.id === e.to),
  );

  return (
    <Card border padding={24} style={{ position: "sticky", top: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <span className="sp-display" style={{ fontSize: 16 }}>
          {node.layer_index != null ? `Layer ${node.layer_index + 1}` : KIND_LABELS[node.kind] ?? node.kind}
        </span>
        <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>{node.id}</span>
      </div>
      {comp.text !== "Complete" && (
        <div style={{ margin: "6px 0" }}>
          <Tag size="sm" color="accent">
            {comp.text}
          </Tag>
          {comp.reasons.map((r, i) => (
            <div key={i} style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
              {r}
            </div>
          ))}
        </div>
      )}

      {interesting
        .filter((n) => n.attention || n.moe || n.mixer)
        .map((n) => (
          <div key={n.id} style={{ margin: "12px 0" }}>
            <Eyebrow style={{ marginBottom: 6 }}>{KIND_LABELS[n.kind] ?? n.kind}</Eyebrow>
            {n.attention && <AttentionAttrs a={n.attention} />}
            {n.moe && <MoeAttrs m={n.moe} />}
            {n.mixer && (
              <AttrRow
                label="Mechanism"
                value={`${n.mixer.mechanism ?? UNKNOWN}${n.mixer.convolution_width ? ` · conv ${n.mixer.convolution_width}` : ""}`}
              />
            )}
          </div>
        ))}

      {node.output_axes && (
        <AttrRow label="Output axes" value={node.output_axes.map((a) => a.name).join(" × ")} />
      )}

      {edges.length > 0 && (
        <>
          <Eyebrow style={{ margin: "14px 0 6px" }}>Flow</Eyebrow>
          {["data", "residual", "routing", "state"].map((kind) => {
            const count = edges.filter((e) => e.kind === kind).length;
            if (!count) return null;
            const colors: Record<string, string> = {
              data: "var(--text)",
              residual: "var(--accent)",
              routing: "var(--accent-2)",
              state: "var(--text-muted)",
            };
            return (
              <div key={kind} style={{ fontFamily: "var(--font-code)", fontSize: 12, color: colors[kind] }}>
                {kind === "residual" ? "═" : kind === "routing" ? "┅" : "─"} {count} {kind} edge
                {count > 1 ? "s" : ""}
              </div>
            );
          })}
        </>
      )}

      <ComponentGroupRows arch={arch} nodeIds={new Set(interesting.map((n) => n.id))} />

      <Eyebrow style={{ margin: "14px 0 6px" }}>
        OBSERVATION POINTS ({nodePoints.length || nodePaths.size})
      </Eyebrow>
      {nodePoints.length === 0 && nodePaths.size === 0 && (
        <div style={{ fontFamily: "var(--font-code)", fontSize: 12, color: "var(--text-muted)" }}>
          not instrumented — no capturable values at this node
        </div>
      )}
      {(nodePoints.length > 0 ? nodePoints : [...nodePaths].map((path) => ({ path }) as ObservationPoint)).map(
        (p) => (
          <div key={p.path} style={{ fontFamily: "var(--font-code)", fontSize: 11, padding: "3px 0", display: "flex", gap: 8 }}>
            <span style={{ wordBreak: "break-all" }}>{p.path}</span>
            <span style={{ color: "var(--text-muted)", flex: "none" }}>
              {p.prefill != null ? (p.prefill ? "P" : "·") : ""}
              {p.decode != null ? (p.decode ? "D" : "·") : ""}
            </span>
          </div>
        ),
      )}
    </Card>
  );
}

function AttrRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", borderBottom: "1px solid var(--spiral-gray-200)" }}>
      <span className="sp-eyebrow" style={{ color: "var(--text)" }}>
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-code)", fontSize: 12, textAlign: "right" }}>{value}</span>
    </div>
  );
}

function AttentionAttrs({ a }: { a: NonNullable<ArchitectureNode["attention"]> }) {
  const rf = a.receptive_field as { kind?: string; window?: number } | string | undefined;
  const rfText =
    typeof rf === "string"
      ? rf
      : rf?.kind
        ? `${rf.kind}${rf.window ? ` (${rf.window})` : ""}`
        : UNKNOWN;
  return (
    <>
      {a.query_heads != null && (
        <AttrRow
          label="Heads"
          value={`${a.query_heads} Q / ${a.key_value_heads ?? UNKNOWN} KV${a.head_sharing ? ` · ${a.head_sharing}` : ""}`}
        />
      )}
      {a.key_head_dimension != null && (
        <AttrRow label="Head dim" value={`k ${a.key_head_dimension} · v ${a.value_head_dimension ?? UNKNOWN}`} />
      )}
      <AttrRow label="Receptive field" value={rfText} />
      {a.mechanism && <AttrRow label="Mechanism" value={a.mechanism} />}
      {a.positional_encoding && <AttrRow label="Position" value={a.positional_encoding} />}
      {a.causal != null && <AttrRow label="Causal" value={a.causal ? "yes" : "no"} />}
    </>
  );
}

function MoeAttrs({ m }: { m: NonNullable<ArchitectureNode["moe"]> }) {
  return (
    <>
      <AttrRow
        label="Experts"
        value={`${m.routed_experts ?? UNKNOWN} routed · top-${m.selected_experts ?? UNKNOWN}${m.shared_experts ? ` · ${m.shared_experts} shared` : ""}`}
      />
      {m.score_transform && <AttrRow label="Scoring" value={m.score_transform} />}
      {m.normalization && <AttrRow label="Normalization" value={m.normalization} />}
    </>
  );
}
