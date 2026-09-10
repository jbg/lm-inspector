//! HuggingFace cache scanning via `hf-cache-reader`, mapped into serde DTOs
//! (the crate's own types are `#[non_exhaustive]` and have no serde impls).
//!
//! Artifact paths are always built as `snapshot_path.join(relative_path)`.
//! `CachedFile::blob_path` must never be used for loading: blobs are stored
//! extensionless, and eredu dispatches on the file extension (and GGUF shard
//! set membership is encoded in the snapshot-relative file names).

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use hf_cache_reader::{scan_cache, CachedRepo, CachedRevision, RepoType};
use serde::{Deserialize, Serialize};

use crate::error::IpcError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSnapshotDto {
    pub cache_dir: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub total_size_on_disk: u64,
    pub models: Vec<CachedModelDto>,
    pub warnings: Vec<CacheWarningDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheWarningDto {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedModelDto {
    pub repo_id: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub size_on_disk: u64,
    /// Millis since epoch.
    #[serde(with = "crate::lossless::u64_string")]
    pub last_modified_ms: u64,
    /// Sorted preferred-first (ref "main", then newest).
    pub revisions: Vec<RevisionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    pub commit_hash: String,
    pub refs: Vec<String>,
    #[serde(with = "crate::lossless::u64_string")]
    pub size_on_disk: u64,
    #[serde(with = "crate::lossless::u64_string")]
    pub last_modified_ms: u64,
    pub artifacts: Vec<ArtifactDto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactRoleDto {
    /// A generation target.
    Model,
    /// A draft/assistant checkpoint (external speculative drafter).
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDto {
    pub format: ArtifactFormatDto,
    pub role: ArtifactRoleDto,
    /// Absolute path eredu can open: the snapshot directory for SafeTensors,
    /// the .gguf file (first shard for sharded sets) for GGUF.
    pub path: String,
    /// Display label: "" for a SafeTensors directory, the file name for GGUF.
    pub label: String,
    #[serde(with = "crate::lossless::u64_string")]
    pub size_bytes: u64,
    pub shard_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactFormatDto {
    SafeTensors,
    Gguf,
}

pub fn scan_model_cache() -> Result<CacheSnapshotDto, IpcError> {
    let cache_dir = hf_cache_reader::resolve_cache_dir();
    let info = scan_cache(&cache_dir)
        .map_err(|e| IpcError::CacheScan { message: e.to_string() })?;

    let mut models: Vec<CachedModelDto> = info
        .repos
        .iter()
        .filter(|r| r.repo_type == RepoType::Model)
        .map(model_dto)
        .collect();
    models.sort_by(|a, b| b.last_modified_ms.cmp(&a.last_modified_ms));

    Ok(CacheSnapshotDto {
        cache_dir: info.cache_dir.display().to_string(),
        total_size_on_disk: info.size_on_disk,
        models,
        warnings: info
            .warnings
            .iter()
            .map(|w| CacheWarningDto {
                path: w.path.display().to_string(),
                message: w.message.clone(),
            })
            .collect(),
    })
}

fn model_dto(repo: &CachedRepo) -> CachedModelDto {
    let mut revisions: Vec<RevisionDto> = repo.revisions.iter().map(revision_dto).collect();
    // Preferred-first: ref "main" wins, then newest, then commit hash for stability.
    revisions.sort_by(|a, b| {
        let a_main = a.refs.iter().any(|r| r == "main");
        let b_main = b.refs.iter().any(|r| r == "main");
        b_main
            .cmp(&a_main)
            .then(b.last_modified_ms.cmp(&a.last_modified_ms))
            .then(a.commit_hash.cmp(&b.commit_hash))
    });
    CachedModelDto {
        repo_id: repo.repo_id.clone(),
        size_on_disk: repo.size_on_disk,
        last_modified_ms: to_ms(repo.last_modified),
        revisions,
    }
}

fn revision_dto(rev: &CachedRevision) -> RevisionDto {
    RevisionDto {
        commit_hash: rev.commit_hash.clone(),
        refs: rev.refs.clone(),
        size_on_disk: rev.size_on_disk,
        last_modified_ms: to_ms(rev.last_modified),
        artifacts: resolve_artifacts(rev),
    }
}

/// Whether a parsed config.json declares an assistant/drafter checkpoint
/// (eredu resolves these through its dedicated AssistantConfigurations
/// registry — model_type "*_assistant", e.g. gemma4_assistant).
fn is_assistant_config(config: &serde_json::Value) -> bool {
    if let Some(model_type) = config.get("model_type").and_then(|v| v.as_str()) {
        if model_type.ends_with("_assistant") {
            return true;
        }
    }
    config
        .get("architectures")
        .and_then(|v| v.as_array())
        .is_some_and(|archs| {
            archs
                .iter()
                .filter_map(|a| a.as_str())
                .any(|a| a.contains("Assistant"))
        })
}

/// A revision may hold one SafeTensors artifact (root config.json plus at
/// least one weight shard — config-only repos stay hidden) and/or any number
/// of GGUF entrypoints. A config declaring an assistant family (eredu's
/// separate AssistantConfigurations registry) yields an assistant-role
/// artifact for the drafter picker.
fn resolve_artifacts(rev: &CachedRevision) -> Vec<ArtifactDto> {
    let mut artifacts = Vec::new();

    let root_config = rev
        .files
        .iter()
        .find(|f| f.relative_path.as_os_str() == std::ffi::OsStr::new("config.json"));
    if let Some(config_file) = root_config {
        let assistant = std::fs::read(
            rev.snapshot_path.join(&config_file.relative_path),
        )
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|config| is_assistant_config(&config));
        let has_weights = rev
            .files
            .iter()
            .any(|f| has_extension(&f.relative_path, "safetensors"));
        if has_weights {
            let size = rev
                .files
                .iter()
                .filter(|f| has_extension(&f.relative_path, "safetensors"))
                .map(|f| f.size_on_disk)
                .sum();
            let shards = rev
                .files
                .iter()
                .filter(|f| has_extension(&f.relative_path, "safetensors"))
                .count() as u32;
            artifacts.push(ArtifactDto {
                format: ArtifactFormatDto::SafeTensors,
                role: if assistant { ArtifactRoleDto::Assistant } else { ArtifactRoleDto::Model },
                path: rev.snapshot_path.display().to_string(),
                label: String::new(),
                size_bytes: size,
                shard_count: shards,
            });
        }
    }

    for file in &rev.files {
        if !has_extension(&file.relative_path, "gguf") {
            continue;
        }
        let Some(name) = file.relative_path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_gguf_entrypoint(name) {
            continue;
        }
        let (size, shards) = gguf_set_size(rev, &file.relative_path);
        // DFlash drafters ship as dflash-*.gguf by convention; the role is a
        // display hint — eredu's assistant admission is the authority.
        let assistant = name.to_ascii_lowercase().starts_with("dflash");
        artifacts.push(ArtifactDto {
            format: ArtifactFormatDto::Gguf,
            role: if assistant { ArtifactRoleDto::Assistant } else { ArtifactRoleDto::Model },
            path: rev.snapshot_path.join(&file.relative_path).display().to_string(),
            label: file.relative_path.display().to_string(),
            size_bytes: size,
            shard_count: shards,
        });
    }

    artifacts
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

/// A .gguf file that is a loadable model entrypoint: excludes companion files
/// (mmproj vision projectors) and non-first shards of `-NNNNN-of-NNNNN` sets
/// (eredu resolves the remaining shards from the first).
fn is_gguf_entrypoint(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if lower.starts_with("mmproj-") || lower.starts_with("mmproj.") {
        return false;
    }
    match shard_index(&lower) {
        Some((index, _total)) => index == 1,
        None => true,
    }
}

/// Parse `...-NNNNN-of-NNNNN.gguf` shard naming; returns (index, total).
fn shard_index(lower_name: &str) -> Option<(u32, u32)> {
    let stem = lower_name.strip_suffix(".gguf")?;
    let (rest, total) = stem.rsplit_once("-of-")?;
    let total: u32 = total.parse().ok()?;
    let (_, index) = rest.rsplit_once('-')?;
    let index: u32 = index.parse().ok()?;
    Some((index, total))
}

/// Total bytes + shard count for the set the given entrypoint belongs to.
fn gguf_set_size(rev: &CachedRevision, entry: &Path) -> (u64, u32) {
    let name = entry.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let lower = name.to_ascii_lowercase();
    let Some((_, total)) = shard_index(&lower) else {
        let size = rev
            .files
            .iter()
            .find(|f| f.relative_path == entry)
            .map(|f| f.size_on_disk)
            .unwrap_or(0);
        return (size, 1);
    };
    // Sum every sibling shard sharing the prefix before `-NNNNN-of-NNNNN.gguf`.
    let prefix = lower.rsplit_once("-of-").map(|(rest, _)| {
        rest.rsplit_once('-').map(|(p, _)| p.to_string()).unwrap_or_default()
    });
    let Some(prefix) = prefix else {
        return (0, total);
    };
    let parent = entry.parent().unwrap_or(Path::new(""));
    let size = rev
        .files
        .iter()
        .filter(|f| {
            f.relative_path.parent().unwrap_or(Path::new("")) == parent
                && f.relative_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.to_ascii_lowercase())
                    .is_some_and(|n| {
                        n.ends_with(".gguf") && n.starts_with(&prefix) && n.contains("-of-")
                    })
        })
        .map(|f| f.size_on_disk)
        .sum();
    (size, total)
}

fn to_ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shard_naming_detects_first_shard_only() {
        assert!(is_gguf_entrypoint("model-00001-of-00003.gguf"));
        assert!(!is_gguf_entrypoint("model-00002-of-00003.gguf"));
        assert!(is_gguf_entrypoint("qwen3-4b-q4_k_m.gguf"));
        assert!(!is_gguf_entrypoint("mmproj-model-f16.gguf"));
    }

    #[test]
    fn assistant_configs_detected() {
        let assistant = serde_json::json!({"model_type": "muse_glimmer_assistant"});
        let by_arch = serde_json::json!({"architectures": ["Gemma4AssistantModel"], "model_type": "x"});
        let model = serde_json::json!({"model_type": "gemma2", "architectures": ["Gemma2ForCausalLM"]});
        assert!(is_assistant_config(&assistant));
        assert!(is_assistant_config(&by_arch));
        assert!(!is_assistant_config(&model));
    }

    #[test]
    fn shard_index_parses() {
        assert_eq!(shard_index("m-00001-of-00002.gguf"), Some((1, 2)));
        assert_eq!(shard_index("m.gguf"), None);
    }
}
