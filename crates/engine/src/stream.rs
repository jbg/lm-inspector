//! Event streaming: envelope schema, the sink abstraction the Tauri layer
//! implements over `Channel`, and the ack-window `DeliveryGate` that turns the
//! webview's consumption rate into backpressure on eredu's synchronous emit
//! callback (blocking the callback is eredu's intended flow-control; a
//! disconnect or stall becomes `ControlFlow::Break`, a permanent clean cancel).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::budgets::{GATE_STALL_SECS, GATE_WINDOW_BYTES, GATE_WINDOW_RECORDS};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Controlled,
    Speculative,
    SpeculativeSemantic,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Deterministic catch-up steps inside a counterfactual branch; the UI
    /// renders these dimmed rather than as fresh generation.
    Replay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventEnvelope {
    #[serde(with = "crate::lossless::u64_string")]
    pub model_epoch: u64,
    pub stream: StreamKind,
    pub run_id: String,
    /// Global monotone per model epoch; the frontend acks by this.
    #[serde(with = "crate::lossless::u64_string")]
    pub envelope_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<Phase>,
    /// The eredu record, pre-serialized to compact JSON. Parsed losslessly on
    /// the frontend so exact 64-bit integers survive.
    pub payload: String,
}

#[derive(Debug)]
pub struct SinkClosed;

/// Implemented by the Tauri layer over `tauri::ipc::Channel`, and by test
/// doubles. `send` must not block. Returns whether a consumer actually
/// received the envelope — an undelivered envelope must not accrue
/// backpressure debt (the journal still has it for paging).
pub trait EventSink: Send + Sync {
    fn send(&self, envelope: RunEventEnvelope) -> Result<bool, SinkClosed>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateSendError {
    Disconnected,
    Stalled,
}

struct GateState {
    next_seq: u64,
    acked_seq: u64,
    unacked_bytes: u64,
}

/// Credit window between the worker and the webview. The emit path appends to
/// the journal, sends on the sink, then blocks here until the frontend's acks
/// catch up. Closing (window destroyed, stream replaced) wakes all waiters
/// with `Disconnected`.
pub struct DeliveryGate {
    state: Mutex<GateState>,
    cv: Condvar,
    disconnected: AtomicBool,
    window_records: u64,
    window_bytes: u64,
    stall: Duration,
}

impl Default for DeliveryGate {
    fn default() -> Self {
        Self::new(GATE_WINDOW_RECORDS, GATE_WINDOW_BYTES, Duration::from_secs(GATE_STALL_SECS))
    }
}

impl DeliveryGate {
    pub fn new(window_records: u64, window_bytes: u64, stall: Duration) -> Self {
        Self {
            state: Mutex::new(GateState { next_seq: 0, acked_seq: 0, unacked_bytes: 0 }),
            cv: Condvar::new(),
            disconnected: AtomicBool::new(false),
            window_records,
            window_bytes,
            stall,
        }
    }

    /// Reserve the next envelope sequence number, charging its payload size.
    pub fn next_seq(&self, payload_bytes: u64) -> u64 {
        let mut st = self.state.lock().expect("gate poisoned");
        let seq = st.next_seq;
        st.next_seq += 1;
        st.unacked_bytes += payload_bytes;
        seq
    }

    /// Block until the window has room (or timeout/disconnect). Called after
    /// the envelope has been sent, so the frontend can always drain.
    pub fn wait_for_credit(&self) -> Result<(), GateSendError> {
        let mut st = self.state.lock().expect("gate poisoned");
        loop {
            if self.disconnected.load(Ordering::SeqCst) {
                return Err(GateSendError::Disconnected);
            }
            let in_flight = st.next_seq.saturating_sub(st.acked_seq);
            if in_flight <= self.window_records && st.unacked_bytes <= self.window_bytes {
                return Ok(());
            }
            let (next, timeout) = self
                .cv
                .wait_timeout(st, self.stall)
                .expect("gate poisoned");
            st = next;
            if timeout.timed_out() {
                let in_flight = st.next_seq.saturating_sub(st.acked_seq);
                if in_flight <= self.window_records && st.unacked_bytes <= self.window_bytes {
                    return Ok(());
                }
                return Err(GateSendError::Stalled);
            }
        }
    }

    /// Frontend ack through `envelope_seq` (inclusive). `bytes_acked` is the
    /// caller-tracked payload total being released.
    pub fn ack(&self, through_seq: u64, bytes_acked: u64) {
        let mut st = self.state.lock().expect("gate poisoned");
        if through_seq >= st.acked_seq {
            st.acked_seq = through_seq + 1;
        }
        st.unacked_bytes = st.unacked_bytes.saturating_sub(bytes_acked);
        drop(st);
        self.cv.notify_all();
    }

    /// Simplified ack that releases all in-flight bytes up to a sequence; used
    /// by the Tauri layer which acks monotonically and does not track bytes.
    pub fn ack_through(&self, through_seq: u64) {
        let mut st = self.state.lock().expect("gate poisoned");
        if through_seq >= st.acked_seq {
            st.acked_seq = through_seq + 1;
            st.unacked_bytes = 0;
        }
        drop(st);
        self.cv.notify_all();
    }

    pub fn close(&self) {
        self.disconnected.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn gate_blocks_then_releases_on_ack() {
        let gate = Arc::new(DeliveryGate::new(2, u64::MAX, Duration::from_secs(5)));
        for _ in 0..3 {
            gate.next_seq(10);
        }
        let g = gate.clone();
        let waiter = std::thread::spawn(move || g.wait_for_credit());
        std::thread::sleep(Duration::from_millis(50));
        assert!(!waiter.is_finished(), "should be blocked over the window");
        gate.ack_through(2);
        assert_eq!(waiter.join().unwrap(), Ok(()));
    }

    #[test]
    fn gate_stall_times_out() {
        let gate = DeliveryGate::new(0, 0, Duration::from_millis(50));
        gate.next_seq(1);
        assert_eq!(gate.wait_for_credit(), Err(GateSendError::Stalled));
    }

    #[test]
    fn gate_close_wakes_waiters() {
        let gate = Arc::new(DeliveryGate::new(0, 0, Duration::from_secs(10)));
        gate.next_seq(1);
        let g = gate.clone();
        let waiter = std::thread::spawn(move || g.wait_for_credit());
        std::thread::sleep(Duration::from_millis(30));
        gate.close();
        assert_eq!(waiter.join().unwrap(), Err(GateSendError::Disconnected));
    }
}
