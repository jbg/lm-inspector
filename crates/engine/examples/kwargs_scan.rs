// Prints chat-template kwargs for each cached SafeTensors model (metadata only).
fn main() {
    let snap = inspector_engine::cache::scan_model_cache().expect("scan");
    for m in snap.models.iter() {
        for r in &m.revisions {
            for a in &r.artifacts {
                if matches!(a.role, inspector_engine::cache::ArtifactRoleDto::Model) {
                    match eredu::api::chat_template_kwargs(&a.path) {
                        Ok(kwargs) => println!("{} :: {:?}", m.repo_id, kwargs),
                        Err(e) => println!("{} :: ERR {}", m.repo_id, e),
                    }
                    break;
                }
            }
        }
    }
}
