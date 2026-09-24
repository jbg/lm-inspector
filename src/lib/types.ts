// TypeScript mirrors of the Rust DTOs and (structurally) the eredu record
// payloads the UI consumes. 64-bit fields are I64 (number | string) — see
// lossless.ts. Unknown/absent values stay undefined and render as "—".

import type { I64 } from "./lossless";

// ---------- cache ----------

export interface CacheSnapshot {
  cacheDir: string;
  totalSizeOnDisk: I64;
  models: CachedModel[];
  warnings: { path: string; message: string }[];
}

export interface CachedModel {
  /** Cache root this repo was found in (multiple caches may be scanned). */
  cacheDir: string;
  repoId: string;
  sizeOnDisk: I64;
  lastModifiedMs: I64;
  revisions: Revision[];
}

export interface Revision {
  commitHash: string;
  refs: string[];
  sizeOnDisk: I64;
  lastModifiedMs: I64;
  artifacts: Artifact[];
}

export interface Artifact {
  format: "safeTensors" | "gguf";
  /** "model" = generation target; "assistant" = external speculative drafter. */
  role: "model" | "assistant";
  path: string;
  label: string;
  sizeBytes: I64;
  shardCount: number;
}

// ---------- cold inspection bundle (eredu shapes, structural) ----------

export type Readiness =
  | "ready"
  | "missing"
  | "unsupported"
  | "invalid"
  | "request_dependent"
  | "unverified"
  | "not_applicable";

export interface InspectionIssue {
  code: string;
  severity: "error" | "warning" | "info";
  detail: string;
  path?: string;
  metadata_key?: string;
  tensor_name?: string;
  tensor_type_code?: number;
}

export interface Observed<T> {
  value?: T;
  unavailable?: string;
  [key: string]: unknown;
}

export interface InspectionReport {
  path: string;
  artifact_format: string;
  model_family?: string;
  architecture?: string;
  gguf_versions?: number[];
  checkpoint_shards?: number;
  tensor_count?: number;
  resources: Record<string, unknown>;
  tensor_encodings: { name: string; ggml_type_code?: number }[];
  expected_modalities: string[];
  container: Readiness;
  architecture_support: Readiness;
  structural_binding: Readiness;
  model_loadability: Readiness;
  requested_load: Readiness;
  text_generation: Readiness;
  tokenizer: Readiness;
  chat_template: Readiness;
  semantic_streaming: Readiness;
  native_tools: Readiness;
  multimodal: Readiness;
  requirements: { code: string; readiness: Readiness; detail: string; path?: string }[];
  issues: InspectionIssue[];
  [key: string]: unknown;
}

export interface TensorAxis {
  name: string;
  dimension: unknown;
}

export interface AttentionAttributes {
  head_sharing?: string;
  query_heads?: number;
  key_value_heads?: number;
  key_head_dimension?: number;
  value_head_dimension?: number;
  receptive_field?: unknown;
  mechanism?: string;
  recurrent?: boolean;
  causal?: boolean;
  positional_encoding?: string;
  [key: string]: unknown;
}

export interface MoeAttributes {
  routed_experts?: number;
  selected_experts?: number;
  shared_experts?: number;
  shared_expert_width?: number;
  shared_expert_gated?: boolean;
  granularity?: number;
  score_transform?: string;
  normalization?: string;
  [key: string]: unknown;
}

export interface MixerAttributes {
  mechanism?: string;
  recurrent?: boolean;
  convolution_width?: number;
  [key: string]: unknown;
}

export interface ArchitectureNode {
  id: string;
  label: string;
  kind: string;
  parent?: string;
  layer_index?: number;
  parameter_groups: string[];
  observation_paths: string[];
  output_axes?: TensorAxis[];
  attention?: AttentionAttributes;
  mixer?: MixerAttributes;
  moe?: MoeAttributes;
  completeness: unknown;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  kind: "data" | "residual" | "routing" | "state" | string;
  [key: string]: unknown;
}

export interface ArchitectureLayerGroup {
  id: string;
  label: string;
  physical_layer_count: number;
  passes: {
    index: number;
    executions: { node_id: string; physical_layer_index: number }[];
  }[];
  weight_sharing: unknown;
  [key: string]: unknown;
}

export interface ObservationPoint {
  path: string;
  node_id: string;
  meaning?: string;
  value_type?: string;
  dtype?: string;
  axes?: TensorAxis[];
  prefill: boolean;
  decode: boolean;
  requirements?: unknown[];
  position?: string;
  retained_bytes?: I64;
  host_bytes?: I64;
  [key: string]: unknown;
}

// ---------- component analysis (architecture schema ≥ 13, component schema ≥ 12) ----------

/** Exact binary32 architecture scalar serialized as its raw bit pattern. */
export type ScalarBits = number;

const scalarView = new DataView(new ArrayBuffer(4));
/** Decode a ComponentScalar bit pattern into its f32 value. */
export function scalarValue(bits: ScalarBits | undefined): number {
  if (bits === undefined) return NaN;
  scalarView.setUint32(0, bits >>> 0);
  return scalarView.getFloat32(0);
}

export interface ComponentNormalization {
  kind: "identity" | "rms" | "layer" | "l2";
  epsilon: ScalarBits;
  gain?: string | null;
  gain_offset: ScalarBits;
  bias?: string | null;
  groups: number;
  [key: string]: unknown;
}

export interface ComponentRead {
  role: string;
  weight: string;
  parameter_group: string;
  shared_weight: string;
  bias?: string | null;
  rows: { kind: string; [key: string]: unknown };
  projection_output?: string | null;
  head_normalization?: unknown;
  source?: unknown;
  input_projections?: unknown[];
  [key: string]: unknown;
}

export interface ComponentGroup {
  id: string;
  node_id: string;
  layer_index: number;
  count: number;
  /** Original (intervenable) activation path; `.effective` sibling below. */
  activation: string;
  effective_activation: string;
  write_input?: string | null;
  write_output?: string | null;
  output?: string | null;
  input: string;
  reads: ComponentRead[];
  routed_reads?: unknown[];
  write_weight: string;
  write_parameter_group: string;
  shared_write_weight: string;
  write_bias?: string | null;
  activation_equation: { kind: string; [key: string]: unknown };
  input_normalization: ComponentNormalization;
  output_normalization?: ComponentNormalization | null;
  output_gate?: unknown;
  residual_scale: ScalarBits;
  write_partition?: unknown;
  [key: string]: unknown;
}

export interface ComponentResidualWrite {
  input?: string | null;
  layer_index: number;
  node_id: string;
  output: string;
  effective_output: string;
  residual_scale: ScalarBits;
  [key: string]: unknown;
}

/** Readout declaration; the equation fields are serde-flattened onto it. */
export interface ComponentReadout {
  embedding: string;
  embedding_weight: string;
  embedding_scale: ScalarBits;
  embedding_normalization?: ComponentNormalization | null;
  token_embedding_normalization?: ComponentNormalization | null;
  tied_embeddings: boolean;
  residual: string;
  normalized: string;
  projection_input?: string | null;
  linear_scores: string;
  logits: string;
  normalization: ComponentNormalization;
  weight: string;
  bias?: string | null;
  output_transform: { kind: string; [key: string]: unknown };
  block_normalizations: unknown[];
  block_transforms?: unknown[];
  other_writes?: ComponentResidualWrite[];
  score_writes?: unknown[];
  stream_residual?: unknown;
  [key: string]: unknown;
}

export interface ArchitectureDescriptor {
  schema_version: number;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  parameter_groups: { id: string; canonical_prefix: string; shared_with?: string }[];
  layer_groups: ArchitectureLayerGroup[];
  observations: { points?: ObservationPoint[]; [key: string]: unknown };
  /** Scalar component groups (empty on descriptors before schema 13, and on
   * architectures with no component declarations — absence is "not
   * described", never "no components"). */
  components?: ComponentGroup[];
  component_transforms?: unknown[];
  routed_components?: unknown[];
  component_readout?: ComponentReadout | null;
  component_scopes?: unknown[];
  completeness: unknown;
}

export interface TensorDescriptor {
  name: string;
  shape: number[];
  dtype: string | { encoded: string } | Record<string, unknown>;
  storage?: { member?: unknown; offset?: I64; length?: I64 };
}

export interface DraftingSupport {
  /** Embedded prediction-head capacity (caps max draft tokens).
   * undefined = unmeasured (unknown ≠ 0); 0 = no heads. */
  embeddedCapacity?: I64;
  /** Family is an external-assistant target at the pinned eredu revision. */
  externalTarget: boolean;
}

export interface InspectionBundle {
  report: InspectionReport;
  architecture: ArchitectureDescriptor;
  tensors: TensorDescriptor[];
  configuration?: unknown;
  family: string;
  effectiveModelType: string;
  drafting: DraftingSupport;
}

// ---------- runs / journal ----------

export interface RunEventEnvelope {
  modelEpoch: I64;
  stream: "controlled" | "speculative" | "speculative_semantic" | "system";
  runId: string;
  envelopeSeq: I64;
  phase?: "replay";
  payload: string;
}

export interface RunLineage {
  parentRunId: string;
  snapshotId: string;
  divergencePrediction: I64;
}

export type RunStatusKind = "active" | "completed" | "cancelled" | "failed";

export interface RunMeta {
  runId: string;
  modelEpoch: I64;
  artifactPath: string;
  modelLabel: string;
  speculative: boolean;
  specJson: string;
  lineage?: RunLineage;
  status: RunStatusKind;
  resumable: boolean;
  pinned: boolean;
  createdMs: I64;
}

export interface RunSummary extends RunMeta {
  envelopeCount: I64;
  byteSize: I64;
}

export interface JournalPage {
  runId: string;
  fromIndex: I64;
  envelopes: RunEventEnvelope[];
  done: boolean;
}

// ---------- misc ----------

export interface BackendAvailability {
  live: boolean;
  metal: boolean;
}

export interface TokenPiece {
  id: number;
  text: string;
}

export interface IpcErrorShape {
  kind: string;
  [key: string]: unknown;
}

export function isIpcError(e: unknown): e is IpcErrorShape {
  return typeof e === "object" && e !== null && "kind" in e;
}

export function ipcErrorMessage(e: unknown): string {
  if (isIpcError(e)) {
    const parts = Object.entries(e)
      .filter(([k]) => k !== "kind" && k !== "chain")
      .map(([, v]) => (typeof v === "string" ? v : ""))
      .filter(Boolean);
    return `${e.kind}${parts.length ? ": " + parts.join(" · ") : ""}`;
  }
  return String(e);
}
