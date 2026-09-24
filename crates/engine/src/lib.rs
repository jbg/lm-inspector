//! LM Inspector engine: eredu integration, HF cache scanning, cold inspection,
//! run journals and the model-owner worker. No Tauri dependency — everything
//! here is testable headless. The `mlx` feature enables live model loading and
//! generation; without it only the cold path (scan + inspect) compiles.

pub mod budgets;
pub mod cache;
pub mod error;
pub mod inspect;
pub mod journal;
pub mod lossless;
pub mod stream;

#[cfg(feature = "mlx")]
pub mod memory;
#[cfg(feature = "mlx")]
pub mod vocab;
#[cfg(feature = "mlx")]
pub mod worker;

pub use error::IpcError;
