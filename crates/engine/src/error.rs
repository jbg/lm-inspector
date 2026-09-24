//! Typed error taxonomy crossing IPC. eredu's rich readiness/issue/capability
//! data is never flattened into these — that information rides in payloads as
//! data. Errors carry the Display message plus the full source chain.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IpcError {
    #[error("cache scan failed: {message}")]
    CacheScan { message: String },
    #[error("inspection failed: {message}")]
    Inspection { message: String, path: Option<String>, chain: Vec<String> },
    #[error("this build has no live backend (requires feature {requires})")]
    BackendUnavailable { requires: String },
    #[error("load failed during {stage}: {message}")]
    Load { stage: String, message: String, chain: Vec<String> },
    #[error("no model is loaded")]
    NotLoaded,
    #[error("a session is active (run {active_run})")]
    SessionActive { active_run: String },
    #[error("no active session")]
    NoActiveSession,
    #[error("stale model epoch: expected {expected}, actual {actual}")]
    StaleEpoch { expected: String, actual: String },
    #[error("run not found: {run_id}")]
    RunNotFound { run_id: String },
    #[error("{op} failed ({class:?}): {message}")]
    Control {
        op: String,
        /// 1:1 with `ControlledGenerationError` variant names.
        class: ControlErrorClass,
        message: String,
        chain: Vec<String>,
    },
    #[error("speculative {op} failed: {message}")]
    Speculative { op: String, message: String, chain: Vec<String> },
    #[error("{operation} unsupported: {reason}")]
    Capability { operation: String, reason: String },
    #[error("no snapshot reaches prediction {requested_prediction}")]
    SnapshotUnreachable {
        requested_prediction: String,
        earliest_reachable: Option<String>,
    },
    #[error("component analysis {stage} failed: {message}")]
    Component { stage: String, message: String, chain: Vec<String> },
    #[error("budget {budget}: {detail}")]
    Budget { budget: String, detail: String },
    #[error("transport: {detail}")]
    Transport { detail: String },
    #[error("worker unavailable: {detail}")]
    Worker { detail: String },
    #[error("internal: {message}")]
    Internal { message: String },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlErrorClass {
    Generation,
    Continuation,
    Choice,
    Sampling,
    Snapshot,
    Control,
    Capture,
}

/// Collect an error's Display plus its full `source()` chain.
pub fn error_chain(err: &dyn std::error::Error) -> Vec<String> {
    let mut chain = Vec::new();
    let mut cur: Option<&dyn std::error::Error> = err.source();
    while let Some(e) = cur {
        chain.push(e.to_string());
        cur = e.source();
    }
    chain
}
