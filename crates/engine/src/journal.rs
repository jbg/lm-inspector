//! Persistent (in-memory) run journals. Journals outlive the worker and the
//! loaded model: runs from an unloaded model stay viewable and comparable,
//! flagged not-resumable. Raw envelope JSON is retained so the frontend can
//! re-page state after a webview reload.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::stream::RunEventEnvelope;

const MAX_RUNS: usize = 32;
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLineage {
    pub parent_run_id: String,
    pub snapshot_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub divergence_prediction: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMeta {
    pub run_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub model_epoch: u64,
    /// Artifact path of the model this run executed on.
    pub artifact_path: String,
    pub model_label: String,
    pub speculative: bool,
    /// The user-facing spec (prompt, settings, plans) as opaque JSON.
    pub spec_json: String,
    pub lineage: Option<RunLineage>,
    pub status: RunStatus,
    pub resumable: bool,
    pub pinned: bool,
    /// Millis since epoch at creation (stamped by the caller).
    #[serde(with = "crate::lossless::u64_string")]
    pub created_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Active,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummaryDto {
    #[serde(flatten)]
    pub meta: RunMeta,
    #[serde(with = "crate::lossless::u64_string")]
    pub envelope_count: u64,
    #[serde(with = "crate::lossless::u64_string")]
    pub byte_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalPageDto {
    pub run_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub from_index: u64,
    pub envelopes: Vec<RunEventEnvelope>,
    pub done: bool,
}

struct RunEntry {
    meta: RunMeta,
    envelopes: Vec<RunEventEnvelope>,
    byte_size: u64,
    last_touch: u64,
}

/// Shared store; lives in Tauri managed state, written from the worker thread
/// through the emit path and read by paging commands.
pub struct JournalStore {
    inner: Mutex<StoreInner>,
}

struct StoreInner {
    runs: HashMap<String, RunEntry>,
    touch_counter: u64,
    total_bytes: u64,
}

impl Default for JournalStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(StoreInner {
                runs: HashMap::new(),
                touch_counter: 0,
                total_bytes: 0,
            }),
        }
    }
}

impl JournalStore {
    pub fn register_run(&self, meta: RunMeta) {
        let mut inner = self.inner.lock().expect("journal poisoned");
        inner.touch_counter += 1;
        let touch = inner.touch_counter;
        let run_id = meta.run_id.clone();
        let entry = inner.runs.entry(run_id).or_insert_with(|| RunEntry {
            meta: meta.clone(),
            envelopes: Vec::new(),
            byte_size: 0,
            last_touch: touch,
        });
        entry.meta = meta;
        Self::evict_locked(&mut inner);
    }

    /// Append an envelope to its run's journal (creating a shell entry if the
    /// run was never registered — branch runs announce themselves this way).
    pub fn append(&self, envelope: &RunEventEnvelope, fallback_meta: impl FnOnce() -> RunMeta) {
        let mut inner = self.inner.lock().expect("journal poisoned");
        inner.touch_counter += 1;
        let touch = inner.touch_counter;
        let bytes = envelope.payload.len() as u64 + 128;
        let entry = inner
            .runs
            .entry(envelope.run_id.clone())
            .or_insert_with(|| RunEntry {
                meta: fallback_meta(),
                envelopes: Vec::new(),
                byte_size: 0,
                last_touch: touch,
            });
        entry.envelopes.push(envelope.clone());
        entry.byte_size += bytes;
        entry.last_touch = touch;
        inner.total_bytes += bytes;
        Self::evict_locked(&mut inner);
    }

    pub fn set_status(&self, run_id: &str, status: RunStatus, resumable: bool) {
        let mut inner = self.inner.lock().expect("journal poisoned");
        if let Some(entry) = inner.runs.get_mut(run_id) {
            entry.meta.status = status;
            entry.meta.resumable = resumable;
        }
    }

    /// Mark every run of earlier epochs not-resumable (called on model switch).
    pub fn retire_epochs_before(&self, epoch: u64) {
        let mut inner = self.inner.lock().expect("journal poisoned");
        for entry in inner.runs.values_mut() {
            if entry.meta.model_epoch < epoch {
                entry.meta.resumable = false;
                if entry.meta.status == RunStatus::Active {
                    entry.meta.status = RunStatus::Cancelled;
                }
            }
        }
    }

    pub fn set_pinned(&self, run_id: &str, pinned: bool) -> bool {
        let mut inner = self.inner.lock().expect("journal poisoned");
        match inner.runs.get_mut(run_id) {
            Some(entry) => {
                entry.meta.pinned = pinned;
                true
            }
            None => false,
        }
    }

    pub fn delete(&self, run_id: &str) -> bool {
        let mut inner = self.inner.lock().expect("journal poisoned");
        if let Some(entry) = inner.runs.remove(run_id) {
            inner.total_bytes = inner.total_bytes.saturating_sub(entry.byte_size);
            true
        } else {
            false
        }
    }

    pub fn list(&self) -> Vec<RunSummaryDto> {
        let inner = self.inner.lock().expect("journal poisoned");
        let mut out: Vec<RunSummaryDto> = inner
            .runs
            .values()
            .map(|entry| RunSummaryDto {
                meta: entry.meta.clone(),
                envelope_count: entry.envelopes.len() as u64,
                byte_size: entry.byte_size,
            })
            .collect();
        out.sort_by(|a, b| b.meta.created_ms.cmp(&a.meta.created_ms));
        out
    }

    pub fn page(&self, run_id: &str, from_index: u64, limit: u64) -> Option<JournalPageDto> {
        let mut inner = self.inner.lock().expect("journal poisoned");
        inner.touch_counter += 1;
        let touch = inner.touch_counter;
        let entry = inner.runs.get_mut(run_id)?;
        entry.last_touch = touch;
        let start = (from_index as usize).min(entry.envelopes.len());
        let end = (start + limit as usize).min(entry.envelopes.len());
        Some(JournalPageDto {
            run_id: run_id.to_string(),
            from_index,
            envelopes: entry.envelopes[start..end].to_vec(),
            done: end == entry.envelopes.len(),
        })
    }

    /// LRU-evict unpinned, non-active runs beyond the caps.
    fn evict_locked(inner: &mut StoreInner) {
        while inner.runs.len() > MAX_RUNS || inner.total_bytes > MAX_TOTAL_BYTES {
            let victim = inner
                .runs
                .iter()
                .filter(|(_, e)| !e.meta.pinned && e.meta.status != RunStatus::Active)
                .min_by_key(|(_, e)| e.last_touch)
                .map(|(id, _)| id.clone());
            match victim {
                Some(id) => {
                    if let Some(entry) = inner.runs.remove(&id) {
                        inner.total_bytes = inner.total_bytes.saturating_sub(entry.byte_size);
                    }
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::{RunEventEnvelope, StreamKind};

    fn meta(id: &str, created: u64) -> RunMeta {
        RunMeta {
            run_id: id.into(),
            model_epoch: 1,
            artifact_path: "/tmp/m".into(),
            model_label: "m".into(),
            speculative: false,
            spec_json: "{}".into(),
            lineage: None,
            status: RunStatus::Completed,
            resumable: false,
            pinned: false,
            created_ms: created,
        }
    }

    fn env(run: &str, seq: u64) -> RunEventEnvelope {
        RunEventEnvelope {
            model_epoch: 1,
            stream: StreamKind::Controlled,
            run_id: run.into(),
            envelope_seq: seq,
            phase: None,
            payload: "{}".into(),
        }
    }

    #[test]
    fn appends_and_pages() {
        let store = JournalStore::default();
        store.register_run(meta("r1", 1));
        for i in 0..5 {
            store.append(&env("r1", i), || meta("r1", 1));
        }
        let page = store.page("r1", 2, 2).unwrap();
        assert_eq!(page.envelopes.len(), 2);
        assert_eq!(page.envelopes[0].envelope_seq, 2);
        assert!(!page.done);
        assert!(store.page("r1", 4, 10).unwrap().done);
    }

    #[test]
    fn evicts_lru_unpinned_over_run_cap() {
        let store = JournalStore::default();
        for i in 0..(MAX_RUNS + 4) {
            let id = format!("r{i}");
            store.register_run(meta(&id, i as u64));
            store.append(&env(&id, 0), || meta(&id, i as u64));
        }
        let list = store.list();
        assert!(list.len() <= MAX_RUNS);
        assert!(!list.iter().any(|r| r.meta.run_id == "r0"), "oldest evicted");
    }

    #[test]
    fn pinned_and_active_survive_eviction() {
        let store = JournalStore::default();
        store.register_run(meta("keep", 0));
        store.set_pinned("keep", true);
        for i in 0..(MAX_RUNS + 8) {
            let id = format!("r{i}");
            store.register_run(meta(&id, (i + 1) as u64));
        }
        assert!(store.list().iter().any(|r| r.meta.run_id == "keep"));
    }
}
