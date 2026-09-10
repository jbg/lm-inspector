import { Heading } from "../../goose/ui";
import { Button } from "../../goose/ui";
import { Toast } from "../../goose/ui";
import { useSession } from "../../state/session";
import { usePlans } from "../../state/plans";
import { useUi } from "../../state/ui";
import { useJournal } from "../../state/journal/useJournal";
import { useNav } from "../../state/nav";
import { LoadGate } from "./LoadGate";
import { Composer } from "./Composer";
import { Transport } from "./Transport";
import { Tape } from "./tape/Tape";
import { Dock } from "./dock/Dock";
import { LineagePanel } from "./LineagePanel";

export function LabScreen() {
  const session = useSession();
  const composing = useUi((s) => s.composing);
  const viewedRunId = useUi((s) => s.viewedRunId) ?? session.activeRunId;
  const journal = useJournal(viewedRunId);
  const go = useNav((s) => s.go);
  const target = usePlans((s) => s.targetArtifact);

  const notices = session.notices;

  if (session.load.phase !== "loaded") {
    return (
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <Heading size="md" color="ink" as="h1" style={{ marginBottom: 16 }}>
          Lab
        </Heading>
        {session.load.phase === "none" && !target ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
            <p style={{ fontFamily: "var(--font-code)", fontSize: 13, color: "var(--text-muted)" }}>
              No model loaded. Pick one from the library — inspection is free,
              weights load only here.
            </p>
            <Button variant="secondary" onClick={() => go({ name: "library" })}>
              Open library
            </Button>
          </div>
        ) : (
          <LoadGate path={target?.path} label={target?.label} />
        )}
        <NoticeStack notices={notices} dismiss={session.dismissNotice} />
      </div>
    );
  }

  const hasRun = !composing && viewedRunId !== undefined && journal !== undefined;
  const loaded = session.load.phase === "loaded" ? session.load.info : undefined;
  const repoId = target?.repoId ?? loaded?.modelLabel;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, height: "100%", maxWidth: 1440, margin: "0 auto" }}>
      {repoId && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flex: "none" }}>
          <span style={{ fontWeight: 500, fontSize: "var(--font-text-md-size)" }}>{repoId}</span>
          {loaded?.effectiveModelType && (
            <span style={{ fontFamily: "var(--font-code)", fontSize: "var(--font-text-xs-size)", color: "var(--color-text-tertiary)" }}>
              {loaded.effectiveModelType}
            </span>
          )}
        </div>
      )}
      {hasRun && <LineagePanel />}
      {hasRun ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gap: 16, flex: 1, minHeight: 0 }}>
          <Tape journal={journal} />
          <Dock journal={journal} />
        </div>
      ) : (
        <Composer />
      )}
      {hasRun && <Transport />}
      <NoticeStack notices={notices} dismiss={session.dismissNotice} />
    </div>
  );
}

function NoticeStack({ notices, dismiss }: { notices: string[]; dismiss: (i: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <div style={{ position: "fixed", bottom: 16, right: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 500 }}>
      {notices.map((n, i) => (
        <Toast key={`${i}-${n}`} tone="ink" onDismiss={() => dismiss(i)}>
          {n}
        </Toast>
      ))}
    </div>
  );
}
