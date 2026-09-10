// The load flow: device + drafting choices, then a staged progress checklist
// driven by system-stream load_stage events. Weights only ever load here.

import { useEffect, useMemo, useState } from "react";
import { Card } from "../../goose/ui";
import { Eyebrow } from "../../goose/ui";
import { Heading } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { Input } from "../../goose/ui";
import { RadioGroup } from "../../goose/ui";
import { Select } from "../../goose/ui";
import { Switch } from "../../goose/ui";
import { useSession } from "../../state/session";
import { usePlans } from "../../state/plans";
import { useLibrary } from "../../state/library";
import { useModel } from "../../state/model";
import { repoDisplayName, formatBytes } from "../../lib/format";
import { i64ToNumber } from "../../lib/lossless";

const STAGES = ["planning", "loading_weights", "fingerprint", "discovery", "vocabulary", "ready"];
const STAGE_LABELS: Record<string, string> = {
  planning: "Plan admitted",
  loading_weights: "Weights resident",
  fingerprint: "Checkpoint fingerprint",
  discovery: "Capture + intervention discovery",
  vocabulary: "Vocabulary table",
  ready: "Session ready",
};

export function LoadGate({ path, label }: { path?: string; label?: string } = {}) {
  const session = useSession();
  const plans = usePlans();
  const [drafterPickerOpen, setDrafterPickerOpen] = useState(false);

  if (session.load.phase === "loading") {
    const currentIndex = STAGES.indexOf(session.load.stage);
    return (
      <Card padding={28} style={{ maxWidth: 640 }}>
        <Heading size="sm" style={{ marginBottom: 18 }}>
          Loading weights
        </Heading>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {STAGES.map((stage, i) => {
            const done = currentIndex > i || session.load.phase !== "loading";
            const active = currentIndex === i;
            return (
              <div key={stage} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: "var(--font-text-sm-size)" }}>
                <span
                  aria-hidden
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "var(--border-radius-full)",
                    background: done ? "var(--accent)" : "transparent",
                    border: `1px solid ${done ? "var(--accent)" : active ? "var(--accent)" : "var(--color-border-secondary)"}`,
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    flex: "none",
                  }}
                >
                  {done ? "✓" : ""}
                </span>
                <span style={{ color: done || active ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
                  {STAGE_LABELS[stage] ?? stage.replace(/_/g, " ")}
                  {active ? "…" : ""}
                </span>
              </div>
            );
          })}
        </div>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 18, marginBottom: 0, wordBreak: "break-all" }}>
          {session.load.path}
        </p>
      </Card>
    );
  }

  if (session.load.phase === "error") {
    return (
      <Card border padding={24} style={{ maxWidth: 640, borderColor: "var(--color-border-danger)" }}>
        <Eyebrow style={{ marginBottom: 10 }}>Load failed</Eyebrow>
        <p style={{ fontFamily: "var(--font-code)", fontSize: 12 }}>{session.load.message}</p>
        <Button variant="secondary" size="sm" onClick={() => path && void session.loadModel(path, plans.device, plans.drafting)}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!path) return null;

  return (
    <Card border padding={24} style={{ maxWidth: 640 }}>
      <Heading size="sm" color="ink" style={{ fontSize: 20, marginBottom: 16 }}>
        {label ?? path}
      </Heading>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>Device</Eyebrow>
          <RadioGroup
            name="device"
            direction="row"
            options={[
              { value: "accelerator", label: "GPU (metal)" },
              { value: "cpu", label: "CPU" },
            ]}
            value={plans.device}
            onChange={(v) => plans.setDevice(v as "cpu" | "accelerator")}
          />
        </div>

        <DraftingSection path={path} open={drafterPickerOpen} setOpen={setDrafterPickerOpen} />

        <Button onClick={() => void session.loadModel(path, plans.device, plans.drafting)}>
          Load model
        </Button>
      </div>
    </Card>
  );
}

export function DraftingSection({
  path,
  open,
  setOpen,
}: {
  path: string;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const plans = usePlans();
  const library = useLibrary();
  const inspect = useModel((s) => s.inspect);
  const entry = useModel((s) => s.inspections[path]);
  const drafting = plans.drafting;
  const kind = drafting.kind;

  useEffect(() => {
    void inspect(path);
  }, [path, inspect]);

  const support = entry?.bundle?.drafting;
  const embeddedCapacity =
    support?.embeddedCapacity !== undefined ? i64ToNumber(support.embeddedCapacity) : undefined;
  const embeddedAvailable = embeddedCapacity !== undefined && embeddedCapacity > 0;
  const externalAvailable = support?.externalTarget === true;

  // Deselect a drafting mode the chosen model cannot do.
  useEffect(() => {
    if (!support) return;
    if (
      (kind === "embedded" && !embeddedAvailable) ||
      (kind === "external" && !externalAvailable)
    ) {
      plans.setDrafting({ kind: "disabled" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [support, kind, embeddedAvailable, externalAvailable]);

  // Purpose-built assistant checkpoints first (eredu resolves them through its
  // AssistantConfigurations registry), then ordinary models, smallest first.
  const drafterOptions = useMemo(() => {
    const models = library.snapshot?.models ?? [];
    return models
      .flatMap((m) =>
        (m.revisions[0]?.artifacts ?? []).map((a) => ({
          value: a.path,
          label:
            `${repoDisplayName(m.repoId)}` +
            (a.role === "assistant" ? " · assistant" : "") +
            ` · ${formatBytes(a.sizeBytes)}`,
          assistant: a.role === "assistant",
          size: i64ToNumber(a.sizeBytes),
        })),
      )
      .filter((a) => a.value !== path)
      .sort((a, b) => Number(b.assistant) - Number(a.assistant) || a.size - b.size);
  }, [library.snapshot, path]);

  const params =
    kind === "embedded" || kind === "external"
      ? drafting
      : { maxDraftTokens: 4, lookahead: false, adaptiveLookahead: false };
  const capForKind = kind === "embedded" ? embeddedCapacity : undefined;

  // Hidden entirely while support is unknown or when the model offers no
  // drafting mode — an unavailable capability is not a form section.
  if (!support || (!embeddedAvailable && !externalAvailable)) {
    return null;
  }

  const options = [
    { value: "disabled", label: "Disabled — ordinary decoding" },
    ...(embeddedAvailable
      ? [{ value: "embedded", label: `Embedded — prediction heads (capacity ${embeddedCapacity})` }]
      : []),
    ...(externalAvailable
      ? [{ value: "external", label: "External — a second model drafts" }]
      : []),
  ];

  return (
    <div>
      <Eyebrow style={{ marginBottom: 8 }}>Drafting (speculative decoding)</Eyebrow>
      <RadioGroup
        name="drafting"
        options={options}
        value={kind}
        onChange={(v) => {
          if (v === "disabled") plans.setDrafting({ kind: "disabled" });
          else if (v === "embedded")
            plans.setDrafting({
              kind: "embedded",
              maxDraftTokens: Math.min(params.maxDraftTokens, embeddedCapacity ?? params.maxDraftTokens),
              lookahead: params.lookahead,
              adaptiveLookahead: params.adaptiveLookahead,
            });
          else {
            plans.setDrafting({
              kind: "external",
              modelPath: drafterOptions[0]?.value ?? "",
              maxDraftTokens: params.maxDraftTokens,
              lookahead: params.lookahead,
              adaptiveLookahead: params.adaptiveLookahead,
            });
            setOpen(true);
          }
        }}
      />
      {kind === "external" && (
        <div style={{ marginTop: 10 }}>
          <Select
            label="Drafter (assistants first, then smallest)"
            options={drafterOptions.map(({ value, label }) => ({ value, label }))}
            value={drafting.kind === "external" ? drafting.modelPath : ""}
            onChange={(v) =>
              drafting.kind === "external" && plans.setDrafting({ ...drafting, modelPath: v })
            }
          />
          <p style={{ fontFamily: "var(--font-code)", fontSize: 10, color: "var(--text-muted)", margin: "4px 0 0" }}>
            drafter/target compatibility is proven by eredu at load — an
            incompatible pick fails with the exact reason
          </p>
          {open && drafterOptions.length === 0 && (
            <p style={{ fontFamily: "var(--font-code)", fontSize: 11, color: "var(--accent)" }}>
              no cached models found to draft with
            </p>
          )}
        </div>
      )}
      {kind !== "disabled" && (
        <div style={{ display: "flex", gap: 16, marginTop: 10, alignItems: "flex-end" }}>
          {/* Hidden when the drafter can only ever propose one token. */}
          {(capForKind === undefined || capForKind > 1) && (
            <Input
              label="Max draft tokens"
              type="number"
              min={1}
              max={capForKind}
              value={String(params.maxDraftTokens)}
              hint={capForKind !== undefined ? `1–${capForKind} (head capacity)` : "≥ 1"}
              onChange={(e) => {
                let v = Math.max(1, Number((e.target as HTMLInputElement).value) || 1);
                if (capForKind !== undefined) v = Math.min(v, capForKind);
                plans.setDrafting({ ...drafting, maxDraftTokens: v } as typeof drafting);
              }}
              style={{ width: 170 }}
            />
          )}
          <Switch
            label="Lookahead"
            checked={params.lookahead}
            onChange={(v) => plans.setDrafting({ ...drafting, lookahead: v } as typeof drafting)}
          />
          <Switch
            label="Adaptive"
            checked={params.adaptiveLookahead}
            onChange={(v) => plans.setDrafting({ ...drafting, adaptiveLookahead: v } as typeof drafting)}
          />
        </div>
      )}
    </div>
  );
}
