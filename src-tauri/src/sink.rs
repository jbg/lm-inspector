//! EventSink implementation over `tauri::ipc::Channel`. The channel slot is
//! replaceable (webview reload re-registers); envelopes always reach the
//! journal regardless, so a missing consumer only skips delivery.

use std::sync::Mutex;

use inspector_engine::stream::{EventSink, RunEventEnvelope, SinkClosed};
use tauri::ipc::Channel;

#[derive(Default)]
pub struct ChannelSink {
    channel: Mutex<Option<Channel<RunEventEnvelope>>>,
}

impl ChannelSink {
    pub fn set_channel(&self, channel: Channel<RunEventEnvelope>) {
        *self.channel.lock().expect("sink poisoned") = Some(channel);
    }

    #[allow(dead_code)]
    pub fn clear(&self) {
        *self.channel.lock().expect("sink poisoned") = None;
    }
}

impl EventSink for ChannelSink {
    fn send(&self, envelope: RunEventEnvelope) -> Result<bool, SinkClosed> {
        let guard = self.channel.lock().expect("sink poisoned");
        match guard.as_ref() {
            Some(channel) => channel.send(envelope).map(|()| true).map_err(|_| SinkClosed),
            // No consumer attached: the journal has it; the frontend can page
            // it back after (re)connecting. No backpressure debt.
            None => Ok(false),
        }
    }
}
