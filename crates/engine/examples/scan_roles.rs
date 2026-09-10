fn main() {
    let snap = inspector_engine::cache::scan_model_cache().expect("scan");
    for m in &snap.models {
        for r in &m.revisions {
            for a in &r.artifacts {
                if matches!(a.role, inspector_engine::cache::ArtifactRoleDto::Assistant) {
                    println!("ASSISTANT {} :: {} ({:?}, {} bytes, {} shards)", m.repo_id, a.label, a.format, a.size_bytes, a.shard_count);
                }
            }
        }
    }
    let total: usize = snap.models.iter().map(|m| m.revisions.iter().map(|r| r.artifacts.len()).sum::<usize>()).sum();
    println!("total artifacts: {total}");
    for w in &snap.warnings {
        println!("WARN {} :: {}", w.path, w.message);
    }
    for m in &snap.models {
        if m.repo_id.contains("Muse") {
            println!("MUSE repo {} revs {}", m.repo_id, m.revisions.len());
            for r in &m.revisions {
                println!("  rev {} artifacts {}", r.commit_hash, r.artifacts.len());
            }
        }
    }
}
