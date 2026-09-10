mod commands;
#[cfg(feature = "mlx")]
mod sink;

use std::sync::Arc;

use inspector_engine::journal::JournalStore;

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(Arc::new(JournalStore::default()))
        .invoke_handler(commands::handler());

    #[cfg(feature = "mlx")]
    let builder = builder
        .manage(commands::live::LiveState::default())
        .on_window_event(commands::live::window_event_hook);

    builder
        .run(tauri::generate_context!())
        .expect("error while running LM Inspector");
}
