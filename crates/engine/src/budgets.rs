//! Default budgets, hard ceilings, and clamping for user-supplied overrides.
//! Values follow the plan's table: generous where eredu treats a limit as
//! terminal (trace), conservative where budgets guard memory (snapshots).

use eredu_core::capture::{CaptureLimitPolicy, CaptureLimits, CaptureUsage};
use eredu_core::execution_control::SnapshotLimits;
use eredu_runtime::execution_control::TraceLimits;
use serde::{Deserialize, Serialize};

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
const GIB: u64 = 1024 * MIB;

pub const DEFAULT_TOP_K: u64 = 16;
pub const MAX_TOP_K: u64 = 128;
pub const DEFAULT_PREVIEW_ELEMENTS: u64 = 64;
pub const MAX_PREVIEW_ELEMENTS: u64 = 4096;
pub const DEFAULT_HISTOGRAM_EDGES: usize = 32;
pub const MAX_HISTOGRAM_EDGES: usize = 128;
pub const DEFAULT_SNAPSHOT_CADENCE: u64 = 8;

/// Headroom subtracted from observed available memory in memory forecasts
/// (other work and forecast uncertainty); eredu's CLI uses the same figure.
pub const MEMORY_RESERVE_BYTES: u64 = 256 * MIB;
/// Output horizon a forecast assumes when a run sets no token limit.
pub const FORECAST_OUTPUT_TOKENS: u64 = 256;
pub const SNAPSHOT_CADENCE_RANGE: (u64, u64) = (1, 64);

/// Delivery gate: unacked window before the emit callback blocks.
pub const GATE_WINDOW_RECORDS: u64 = 256;
pub const GATE_WINDOW_BYTES: u64 = 8 * MIB;
pub const GATE_STALL_SECS: u64 = 30;

pub fn default_trace_limits() -> TraceLimits {
    TraceLimits { per_record_bytes: MIB, total_bytes: 64 * MIB }
}

pub fn trace_ceiling() -> TraceLimits {
    TraceLimits { per_record_bytes: 8 * MIB, total_bytes: 512 * MIB }
}

pub fn default_capture_limits() -> CaptureLimits {
    CaptureLimits {
        per_step: CaptureUsage {
            captures: 32,
            retained_bytes: 32 * MIB,
            host_bytes: 8 * MIB,
            encoded_bytes: 2 * MIB,
        },
        cumulative: CaptureUsage {
            captures: 8192,
            retained_bytes: 2 * GIB,
            host_bytes: 512 * MIB,
            encoded_bytes: 96 * MIB,
        },
        // MLX rejects a physical ceiling it cannot prove; never set it.
        physical_native_bytes: None,
        on_limit: CaptureLimitPolicy::Skip,
    }
}

pub fn capture_ceiling() -> CaptureLimits {
    CaptureLimits {
        per_step: CaptureUsage {
            captures: 128,
            retained_bytes: 256 * MIB,
            host_bytes: 32 * MIB,
            encoded_bytes: 8 * MIB,
        },
        cumulative: CaptureUsage {
            captures: 32768,
            retained_bytes: 8 * GIB,
            host_bytes: 2 * GIB,
            encoded_bytes: 512 * MIB,
        },
        physical_native_bytes: None,
        on_limit: CaptureLimitPolicy::Fail,
    }
}

/// 12 automatic + 4 user-pinned snapshots.
pub const DEFAULT_AUTO_SNAPSHOTS: u64 = 12;

pub fn default_snapshot_limits() -> SnapshotLimits {
    SnapshotLimits {
        max_snapshots: 16,
        max_branches: 8,
        retained_bytes: 4 * GIB,
        cumulative_copy_bytes: 16 * GIB,
    }
}

pub fn snapshot_ceiling() -> SnapshotLimits {
    SnapshotLimits {
        max_snapshots: 32,
        max_branches: 16,
        retained_bytes: 8 * GIB,
        cumulative_copy_bytes: 64 * GIB,
    }
}

/// User-adjustable budget overrides; anything absent keeps the default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BudgetOverridesDto {
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub trace_per_record_bytes: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub trace_total_bytes: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub snapshot_max_snapshots: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub snapshot_max_branches: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub snapshot_retained_bytes: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub snapshot_cumulative_copy_bytes: Option<u64>,
    #[serde(with = "crate::lossless::opt_u64_string", skip_serializing_if = "Option::is_none")]
    pub snapshot_cadence: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClampNote {
    pub field: String,
    pub requested: String,
    pub clamped_to: String,
}

pub struct ResolvedBudgets {
    pub trace: TraceLimits,
    pub capture: CaptureLimits,
    pub snapshots: SnapshotLimits,
    pub snapshot_cadence: u64,
    pub notes: Vec<ClampNote>,
}

pub fn resolve(overrides: &BudgetOverridesDto) -> ResolvedBudgets {
    let mut notes = Vec::new();
    let mut clamp = |field: &str, requested: u64, lo: u64, hi: u64| -> u64 {
        let clamped = requested.clamp(lo, hi);
        if clamped != requested {
            notes.push(ClampNote {
                field: field.to_string(),
                requested: requested.to_string(),
                clamped_to: clamped.to_string(),
            });
        }
        clamped
    };

    let td = default_trace_limits();
    let tc = trace_ceiling();
    let trace = TraceLimits {
        per_record_bytes: overrides
            .trace_per_record_bytes
            .map(|v| clamp("tracePerRecordBytes", v, 64 * KIB, tc.per_record_bytes))
            .unwrap_or(td.per_record_bytes),
        total_bytes: overrides
            .trace_total_bytes
            .map(|v| clamp("traceTotalBytes", v, MIB, tc.total_bytes))
            .unwrap_or(td.total_bytes),
    };

    let sd = default_snapshot_limits();
    let sc = snapshot_ceiling();
    let snapshots = SnapshotLimits {
        max_snapshots: overrides
            .snapshot_max_snapshots
            .map(|v| clamp("snapshotMaxSnapshots", v, 1, sc.max_snapshots))
            .unwrap_or(sd.max_snapshots),
        max_branches: overrides
            .snapshot_max_branches
            .map(|v| clamp("snapshotMaxBranches", v, 1, sc.max_branches))
            .unwrap_or(sd.max_branches),
        retained_bytes: overrides
            .snapshot_retained_bytes
            .map(|v| clamp("snapshotRetainedBytes", v, 64 * MIB, sc.retained_bytes))
            .unwrap_or(sd.retained_bytes),
        cumulative_copy_bytes: overrides
            .snapshot_cumulative_copy_bytes
            .map(|v| clamp("snapshotCumulativeCopyBytes", v, 256 * MIB, sc.cumulative_copy_bytes))
            .unwrap_or(sd.cumulative_copy_bytes),
    };

    let snapshot_cadence = overrides
        .snapshot_cadence
        .map(|v| clamp("snapshotCadence", v, SNAPSHOT_CADENCE_RANGE.0, SNAPSHOT_CADENCE_RANGE.1))
        .unwrap_or(DEFAULT_SNAPSHOT_CADENCE);

    ResolvedBudgets {
        trace,
        capture: default_capture_limits(),
        snapshots,
        snapshot_cadence,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_out_of_range_and_notes_it() {
        let resolved = resolve(&BudgetOverridesDto {
            snapshot_cadence: Some(1000),
            trace_total_bytes: Some(1),
            ..Default::default()
        });
        assert_eq!(resolved.snapshot_cadence, 64);
        assert_eq!(resolved.trace.total_bytes, MIB);
        assert_eq!(resolved.notes.len(), 2);
    }

    #[test]
    fn defaults_pass_through_unclamped() {
        let resolved = resolve(&BudgetOverridesDto::default());
        assert!(resolved.notes.is_empty());
        assert_eq!(resolved.snapshots.max_snapshots, 16);
        assert!(resolved.capture.physical_native_bytes.is_none());
    }
}
