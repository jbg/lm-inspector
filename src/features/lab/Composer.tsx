// Pre-run composer: prompt, sampling, capture recipes. One scrolling panel,
// no modal editors. Non-default sampling values get the magenta left border —
// the settings-diff primitive reused by comparisons.

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { Switch } from "../../goose/ui";
import { RadioGroup } from "../../goose/ui";
import { Tag } from "../../goose/ui";
import { useSession } from "../../state/session";
import { useUi } from "../../state/ui";
import { Select } from "../../goose/ui";
import { buildStartSpec, memoryBudgetBytes, parseTools, usePlans } from "../../state/plans";
import type { MessageDraft } from "../../state/plans";
import { live, type MemoryForecast, type StartRunSpec } from "../../lib/liveIpc";
import { ipcErrorMessage } from "../../lib/types";
import { MemoryForecastView } from "../common/MemoryForecastView";

export function Composer() {
  const session = useSession();
  const plans = usePlans();
  const info = session.load.phase === "loaded" ? session.load.info : undefined;
  // Drafting resources are realized at load but sit in their own execution
  // part — ordinary sessions on the same weights never touch them, so the
  // run kind is a per-run choice whenever the load carried a drafter.
  const draftingAvailable = (info?.drafting ?? "disabled") !== "disabled";
  const speculative = draftingAvailable && plans.useDrafting;
  // `?? undefined` normalizes a serialized null (absent-as-null from older
  // engine builds) so presence checks below can rely on strict undefined.
  const controlUnsupported = info?.controlSupport ?? undefined;
  // Observed generation is semantic-only: unavailable when the template has
  // no recognized format, and always for raw-text prompts.
  const observedUnsupported = plans.textMode
    ? "raw text prompts run the text pipeline — observed generation is semantic"
    : (info?.observedSupport ?? undefined);
  // Effective session mode: when exactly one mode is unavailable, force the
  // other regardless of the stored preference (derived, not a coercing effect
  // — the radio and the run stay in sync with no stale frame).
  const execution =
    controlUnsupported !== undefined && observedUnsupported === undefined
      ? "observed"
      : observedUnsupported !== undefined && controlUnsupported === undefined
        ? "controlled"
        : plans.execution;

  const { layerOutputPaths, routingPaths } = useMemo(() => {
    const points = session.captureDiscovery?.catalog?.points ?? [];
    return {
      layerOutputPaths: points
        .map((p) => p.path)
        .filter((p) => /\.output$/.test(p) && p.includes("layers")),
      routingPaths: points.map((p) => p.path).filter((p) => p.includes("routing.")),
    };
  }, [session.captureDiscovery]);

  const start = async () => {
    const spec = buildStartSpec({ ...plans, execution }, layerOutputPaths, routingPaths, speculative);
    const started = await session.startRun(spec, speculative);
    if (started) {
      useUi.getState().viewRun(started.runId);
      useUi.getState().clearSelection();
    }
  };

  const lastRunId = useUi((s) => s.viewedRunId) ?? session.activeRunId;
  const toolsError = plans.textMode ? undefined : parseTools(plans.toolsJson).error;
  // An empty prompt is a valid run: the model samples from BOS (text mode)
  // or from the template's bare preamble (chat mode).
  const canStart = !toolsError;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 16, alignItems: "start" }}>
      <Card border padding={24}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <Eyebrow>Prompt</Eyebrow>
          {speculative && <Tag size="sm">Speculative · {info?.drafting}</Tag>}
          <div style={{ flex: 1 }} />
          {draftingAvailable && (
            <Switch label="Drafting" checked={plans.useDrafting} onChange={plans.setUseDrafting} />
          )}
          {lastRunId && (
            <Button size="sm" variant="ghost" onClick={() => useUi.getState().viewRun(lastRunId)}>
              ◂ Back to run
            </Button>
          )}
          <Switch label="Raw text" checked={plans.textMode} onChange={plans.setTextMode} />
        </div>

        {plans.textMode ? (
          <RawPromptEditor
            value={plans.rawText}
            onChange={plans.setRawText}
            specialTokens={info?.specialTokens ?? []}
            eosTokenIds={info?.eosTokenIds ?? []}
          />
        ) : (
          <MessageEditor messages={plans.messages} onChange={plans.setMessages} />
        )}

        {/* enable_thinking is tri-state in eredu: unset = whatever the
            template itself defaults to (some models default thinking on). */}
        {!plans.textMode &&
          ["enable_thinking", "reasoning_effort"].some((k) =>
            (info?.chatTemplateKwargs ?? []).includes(k),
          ) && (
            <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-end" }}>
              {(info?.chatTemplateKwargs ?? []).includes("enable_thinking") && (
                <Select
                  label="Thinking"
                  options={[
                    { value: "default", label: "Template default" },
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  value={
                    plans.enableThinking === undefined ? "default" : plans.enableThinking ? "on" : "off"
                  }
                  onChange={(v) => plans.setThinking(v === "default" ? undefined : v === "on")}
                  style={{ width: 170 }}
                />
              )}
              {(info?.chatTemplateKwargs ?? []).includes("reasoning_effort") && (
                <Select
                  label="Reasoning effort"
                  options={[
                    { value: "default", label: "Template default" },
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                  value={plans.reasoningEffort ?? "default"}
                  onChange={(v) => plans.setReasoningEffort(v === "default" ? undefined : v)}
                  style={{ width: 170 }}
                />
              )}
            </div>
          )}

        {!plans.textMode && <ToolsPanel error={toolsError} />}

        {!speculative && (
          <div style={{ marginTop: 16 }}>
            <Eyebrow style={{ marginBottom: 8 }}>Session</Eyebrow>
            <RadioGroup
              name="execution"
              direction="row"
              options={[
                {
                  value: "controlled",
                  label: "Controlled — step, force, branch",
                  disabled: controlUnsupported !== undefined,
                  title: controlUnsupported,
                },
                {
                  value: "observed",
                  label: "Observed — free-run to completion",
                  disabled: observedUnsupported !== undefined,
                  title: observedUnsupported,
                },
              ]}
              value={execution}
              onChange={(v) => plans.setExecution(v as "controlled" | "observed")}
            />
            {controlUnsupported !== undefined && (
              <p
                title={controlUnsupported}
                style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "6px 0 0", maxWidth: 520 }}
              >
                Controlled execution isn't available for this model's architecture — it
                can't snapshot execution state, which stepping, forcing, and branching
                need. Generation, captures, and pre-planned interventions still work in
                observed mode.
              </p>
            )}
            {observedUnsupported !== undefined && !plans.textMode && (
              <p
                title={observedUnsupported}
                style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "6px 0 0", maxWidth: 520 }}
              >
                Observed (free-run) generation isn't available — it runs the semantic
                pipeline, and this chat template has no recognized format. Controlled
                execution runs the text fallback instead.
              </p>
            )}
          </div>
        )}

        <div style={{ marginTop: 24, display: "flex", gap: 12, alignItems: "center" }}>
          <Button disabled={!canStart} onClick={() => void start()}>
            Start ▸
          </Button>
          <span style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)" }}>
            snapshots: auto every 8 predictions · top-{plans.capture.topK.count} candidates
            {speculative ? " · speculative capture is model.logits only" : ""}
          </span>
        </div>
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <SamplingPanel />
        <CapturePanel speculative={speculative} hasMoe={routingPaths.length > 0} />
        <MemoryPanel
          spec={buildStartSpec({ ...plans, execution }, layerOutputPaths, routingPaths, speculative)}
          speculative={speculative}
          prefillChunkingUnsupported={info?.prefillChunkingUnsupported ?? undefined}
        />
      </div>
    </div>
  );
}

/** Prefill policy plus a live memory forecast of exactly this run: eredu's
 * cold estimator over the loaded selection, with the prompt rendered and
 * tokenized the way the run will be. Forecasts need the idle model (the
 * prompt render borrows it), so an active session pauses them. */
function MemoryPanel({
  spec,
  speculative,
  prefillChunkingUnsupported,
}: {
  spec: StartRunSpec;
  speculative: boolean;
  prefillChunkingUnsupported?: string;
}) {
  const plans = usePlans();
  const m = plans.inference;
  const modelEpoch = useSession((s) => s.modelEpoch);
  const loaded = useSession((s) => s.load.phase === "loaded");
  const activeRunId = useSession((s) => s.activeRunId);
  const [forecast, setForecast] = useState<MemoryForecast>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));

  // Stable identity for "the same request": the seed is drawn fresh per
  // render when blank and the timestamp changes every call, and neither
  // affects memory.
  const specKey = useMemo(() => {
    const { seed: _seed, createdMs: _created, ...rest } = spec;
    return JSON.stringify(rest);
  }, [spec]);
  const idle = loaded && activeRunId === undefined;
  const budgetBytes = memoryBudgetBytes(plans.memoryBudgetGib);

  useEffect(() => {
    if (!idle) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setBusy(true);
      const request = JSON.parse(specKey) as StartRunSpec;
      live
        .forecastRunMemory(modelEpoch, { ...request, seed: 0, createdMs: 0 }, speculative, budgetBytes)
        .then((result) => {
          if (cancelled) return;
          setForecast(result);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(ipcErrorMessage(e));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [specKey, speculative, idle, modelEpoch, budgetBytes]);

  return (
    <Card border padding={20}>
      <Eyebrow style={{ marginBottom: 12 }}>Memory</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
        <Input
          label="Prefill chunk (positions)"
          type="number"
          step="1"
          min="0"
          placeholder="512"
          hint={
            prefillChunkingUnsupported !== undefined
              ? `this executable prefills in one pass: ${prefillChunkingUnsupported}`
              : "prompt positions per prefill pass; 0 = one complete pass. Captures, interventions and speculative runs keep a full pass."
          }
          value={m.prefillChunkPositions === undefined ? "" : String(m.prefillChunkPositions)}
          onChange={(e) => plans.setInference({ prefillChunkPositions: num((e.target as HTMLInputElement).value) })}
          style={{
            minWidth: 0,
            borderLeft: m.prefillChunkPositions !== undefined ? "3px solid var(--accent)" : "3px solid transparent",
            paddingLeft: 6,
          }}
        />
        <Input
          label="Memory budget (GiB)"
          type="number"
          step="any"
          min="0"
          placeholder="none"
          hint="application budget the fit verdict compares with; the backend often cannot observe free memory"
          value={plans.memoryBudgetGib === undefined ? "" : String(plans.memoryBudgetGib)}
          onChange={(e) => plans.setMemoryBudgetGib(num((e.target as HTMLInputElement).value))}
          style={{ minWidth: 0, borderLeft: "3px solid transparent", paddingLeft: 6 }}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Eyebrow style={{ marginBottom: 6 }}>Forecast{busy ? " …" : ""}</Eyebrow>
        {!idle ? (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            {loaded
              ? "End the session to forecast — rendering the prompt needs the idle model."
              : "Load a model to forecast this run's memory."}
          </p>
        ) : error ? (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--color-text-danger)", margin: 0 }}>
            forecast unavailable: {error}
          </p>
        ) : forecast ? (
          <MemoryForecastView forecast={forecast} />
        ) : (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            forecasting…
          </p>
        )}
      </div>
    </Card>
  );
}

/** Raw-text prompt: exactly what is typed is what gets prefilled — no chat
 * template and no automatic BOS. Special tokens typed literally encode to
 * their single ids, so the picker just splices the literal text at the caret. */
function RawPromptEditor({
  value,
  onChange,
  specialTokens,
  eosTokenIds,
}: {
  value: string;
  onChange: (text: string) => void;
  specialTokens: { id: number; text: string }[];
  eosTokenIds: number[];
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const eos = new Set(eosTokenIds);
  const insert = (text: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    // Restore the caret after the inserted token once React has re-rendered.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="raw prompt — no template, no automatic BOS, no tool/reasoning parsing"
        style={textareaStyle}
        rows={8}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Select
          label="Insert special token"
          placeholder={specialTokens.length > 0 ? "choose a token…" : "none in this tokenizer"}
          value=""
          disabled={specialTokens.length === 0}
          options={specialTokens.map((t) => ({
            value: t.text,
            label: `${t.text} · ${t.id}${eos.has(t.id) ? " · eos" : ""}`,
          }))}
          onChange={(text) => {
            if (text) insert(text);
          }}
          style={{ minWidth: 260 }}
        />
        <span style={{ fontSize: 11, color: "var(--text-muted)", paddingBottom: 6 }}>
          Raw mode prefills exactly this text. The model needs at least one token to
          start from: insert BOS or end-of-text to sample with no prompt.
        </span>
      </div>
    </div>
  );
}

const textareaStyle: React.CSSProperties = {
  width: "100%",
  border: "2px solid var(--border)",
  background: "var(--surface)",
  fontFamily: "var(--font-code)",
  fontSize: 13,
  padding: 10,
  resize: "vertical",
  outline: "none",
};

function MessageEditor({
  messages,
  onChange,
}: {
  messages: MessageDraft[];
  onChange: (m: MessageDraft[]) => void;
}) {
  const update = (i: number, patch: Partial<MessageDraft>) => {
    onChange(messages.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {messages.map((m, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <button
            onClick={() => {
              const next = m.role === "system" ? "user" : m.role === "user" ? "assistant" : "system";
              update(i, { role: next });
            }}
            className="sp-eyebrow"
            style={{
              border: "1px solid var(--accent-2)",
              color: "var(--accent-2)",
              background: "none",
              padding: "6px 10px",
              cursor: "pointer",
              width: 96,
              flex: "none",
            }}
            title="click to cycle role"
          >
            {m.role.charAt(0).toUpperCase() + m.role.slice(1)}
          </button>
          <textarea
            value={m.content}
            onChange={(e) => update(i, { content: e.target.value })}
            style={{ ...textareaStyle, minHeight: 60 }}
            rows={2}
          />
          {messages.length > 1 && (
            <button
              onClick={() => onChange(messages.filter((_, j) => j !== i))}
              style={{ border: "1px solid var(--border)", background: "none", cursor: "pointer", width: 28, height: 28, fontFamily: "var(--font-body)" }}
              aria-label="remove message"
            >
              ×
            </button>
          )}
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...messages, { role: "user", content: "" }])}>
        + Message
      </Button>
    </div>
  );
}

function SamplingPanel() {
  const plans = usePlans();
  const session = useSession();
  const s = plans.sampling;
  const num = (v: string): number | undefined => (v === "" ? undefined : Number(v));
  const checkpoint =
    session.load.phase === "loaded"
      ? (session.load.info.checkpointGenerationConfig ?? {})
      : {};

  // Empty field = inherit: eredu resolves it from the checkpoint's
  // generation_config; the placeholder shows that inherited value.
  const field = (
    label: string,
    key: "temperature" | "topK" | "topP" | "minP" | "repetitionPenalty" | "maxNewTokens",
    checkpointKey: string,
    step?: string,
  ) => {
    const overridden = s[key] !== undefined;
    const inherited = checkpoint[checkpointKey];
    return (
      <Input
        label={label}
        type="number"
        step={step ?? "any"}
        value={s[key] === undefined ? "" : String(s[key])}
        placeholder={inherited != null ? String(inherited) : "model default"}
        onChange={(e) => plans.setSampling({ [key]: num((e.target as HTMLInputElement).value) })}
        style={{ minWidth: 0, borderLeft: overridden ? "3px solid var(--accent)" : "3px solid transparent", paddingLeft: 6 }}
      />
    );
  };

  return (
    <Card border padding={20}>
      <Eyebrow style={{ marginBottom: 12 }}>Sampling</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12 }}>
        {field("Temperature", "temperature", "temperature")}
        {field("Top-k", "topK", "top_k", "1")}
        {field("Top-p", "topP", "top_p")}
        {field("Min-p", "minP", "min_p")}
        {field("Rep. penalty", "repetitionPenalty", "repetition_penalty")}
        {field("Max tokens", "maxNewTokens", "max_new_tokens", "1")}
      </div>
      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "flex-end" }}>
        <Input
          label="Seed"
          type="number"
          placeholder="Random"
          hint="blank = a fresh random seed each run"
          value={s.seed === undefined ? "" : String(s.seed)}
          onChange={(e) => {
            const raw = (e.target as HTMLInputElement).value.trim();
            plans.setSampling({ seed: raw === "" ? undefined : Number(raw) });
          }}
          style={{ flex: 1, minWidth: 0, borderLeft: "3px solid transparent", paddingLeft: 6 }}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <RadioGroup
          name="strategy"
          direction="row"
          options={[
            { value: "standard", label: "Standard" },
            { value: "mirostatV2", label: "Mirostat v2" },
          ]}
          value={s.strategy}
          onChange={(v) => plans.setSampling({ strategy: v as "standard" | "mirostatV2" })}
        />
        {s.strategy === "mirostatV2" && (
          <div style={{ display: "flex", gap: 12, marginTop: 10 }}>
            <Input label="Tau" type="number" style={{ minWidth: 0, flex: 1, borderLeft: "3px solid transparent", paddingLeft: 6 }} value={String(s.tau)} onChange={(e) => plans.setSampling({ tau: Number((e.target as HTMLInputElement).value) || 5 })} />
            <Input label="Eta" type="number" style={{ minWidth: 0, flex: 1, borderLeft: "3px solid transparent", paddingLeft: 6 }} value={String(s.eta)} onChange={(e) => plans.setSampling({ eta: Number((e.target as HTMLInputElement).value) || 0.1 })} />
          </div>
        )}
      </div>
    </Card>
  );
}

function CapturePanel({ speculative, hasMoe }: { speculative: boolean; hasMoe: boolean }) {
  const plans = usePlans();
  const c = plans.capture;
  return (
    <Card border padding={20}>
      <Eyebrow style={{ marginBottom: 12 }}>Signals (capture plan)</Eyebrow>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Switch
            label={`Token alternates · top-${c.topK.count}`}
            checked={c.topK.enabled}
            onChange={(v) => plans.setCapture({ topK: { ...c.topK, enabled: v } })}
          />
          <input
            type="range"
            min={4}
            max={64}
            value={c.topK.count}
            onChange={(e) => plans.setCapture({ topK: { ...c.topK, count: Number(e.target.value) } })}
            style={{ width: 90, accentColor: "var(--accent)" }}
          />
        </div>
        {!c.topK.enabled && (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--accent)", margin: 0 }}>
            without alternates, token probabilities and Force are unavailable
          </p>
        )}
        <Switch
          label="Layer trajectory (summary per layer output)"
          checked={c.layerTrajectory.enabled}
          disabled={speculative}
          onChange={(v) => plans.setCapture({ layerTrajectory: { ...c.layerTrajectory, enabled: v } })}
        />
        {hasMoe && (
          <Switch
            label="MoE routing (selected experts per token)"
            checked={c.moeRouting.enabled}
            disabled={speculative}
            onChange={(v) => plans.setCapture({ moeRouting: { enabled: v } })}
          />
        )}
        {speculative && (
          <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            speculative runs capture one-row model.logits only (target and
            draft) — load without drafting for layer signals
          </p>
        )}
      </div>
    </Card>
  );
}


const TOOL_PRESETS: { label: string; tool: object }[] = [
  {
    label: "get_weather",
    tool: {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather for a location.",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string", description: "City name" },
            unit: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["location"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    label: "search_web",
    tool: {
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web and return the top results.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  },
  {
    label: "run_python",
    tool: {
      type: "function",
      function: {
        name: "run_python",
        description: "Execute a Python snippet and return stdout.",
        parameters: {
          type: "object",
          properties: { code: { type: "string" } },
          required: ["code"],
          additionalProperties: false,
        },
      },
    },
  },
];

function ToolsPanel({ error }: { error?: string }) {
  const plans = usePlans();
  const { tools } = parseTools(plans.toolsJson);
  const hasTools = tools.length > 0;

  const addPreset = (tool: object) => {
    const { tools: current, error: parseError } = parseTools(plans.toolsJson);
    const next = parseError ? [tool] : [...current, tool];
    plans.setToolsJson(JSON.stringify(next, null, 2));
  };

  return (
    <details open={hasTools || !!error} style={{ marginTop: 14 }}>
      <summary className="sp-eyebrow" style={{ cursor: "pointer" }}>
        Tools{hasTools ? ` · ${tools.length}` : ""}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-tertiary)" }}>
            presets:
          </span>
          {TOOL_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => addPreset(p.tool)}
              style={{
                border: "1px solid var(--color-border-secondary)",
                borderRadius: "var(--border-radius-full)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                fontFamily: "var(--font-code)",
                fontSize: 11,
                padding: "2px 10px",
                cursor: "pointer",
              }}
            >
              + {p.label}
            </button>
          ))}
          {hasTools && (
            <button
              onClick={() => plans.setToolsJson("")}
              style={{
                border: "none",
                background: "none",
                color: "var(--color-text-tertiary)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              clear
            </button>
          )}
        </div>
        <textarea
          value={plans.toolsJson}
          onChange={(e) => plans.setToolsJson(e.target.value)}
          placeholder='[{"type": "function", "function": {"name": "…", "parameters": {…}}}]'
          spellCheck={false}
          style={{ ...textareaStyle, minHeight: hasTools ? 140 : 60, fontSize: 12 }}
          rows={hasTools ? 8 : 3}
        />
        {error && (
          <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-danger)" }}>
            invalid tools JSON: {error}
          </span>
        )}
        {hasTools && !error && (
          <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
            <Select
              label="Tool choice"
              options={[
                { value: "auto", label: "auto — model may call tools" },
                { value: "none", label: "none — declared but forbidden" },
                { value: "required", label: "required — must call a tool" },
              ]}
              value={plans.toolChoice}
              onChange={(v) => plans.setToolChoice(v as "auto" | "none" | "required")}
              style={{ width: 280 }}
            />
            {plans.toolChoice !== "none" && (
              <span style={{ fontSize: "var(--font-text-xs-size)", color: "var(--color-text-tertiary)", paddingBottom: 8 }}>
                callable tools activate a grammar that blocks snapshots — forcing
                the next token still works; branching from past tokens won't
              </span>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
