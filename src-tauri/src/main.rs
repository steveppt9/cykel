// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crypto;
mod models;
mod prediction;
mod storage;

use commands::AppState;

fn main() {
    tauri::Builder::default()
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::is_setup,
            commands::setup,
            commands::unlock,
            commands::lock,
            commands::log_day,
            commands::get_month,
            commands::get_predictions,
            commands::get_stats,
            commands::get_settings,
            commands::toggle_fertility,
            commands::update_settings,
            commands::export_data,
            commands::wipe_all_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cykel");
}
