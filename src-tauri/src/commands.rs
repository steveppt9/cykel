use chrono::NaiveDate;
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::models::*;
use crate::prediction;
use crate::storage;

/// App state holding the decrypted data and passphrase while unlocked.
pub struct AppState {
    pub passphrase: Mutex<Option<String>>,
    pub data: Mutex<Option<AppData>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            passphrase: Mutex::new(None),
            data: Mutex::new(None),
        }
    }

    /// Lock the app: zeroize passphrase and drop data from memory.
    pub fn lock(&self) {
        if let Ok(mut pass) = self.passphrase.lock() {
            if let Some(ref mut p) = *pass {
                p.zeroize();
            }
            *pass = None;
        }
        if let Ok(mut data) = self.data.lock() {
            *data = None;
        }
    }

    fn save_data(&self) -> Result<(), String> {
        let pass = self.passphrase.lock().map_err(|e| e.to_string())?;
        let data = self.data.lock().map_err(|e| e.to_string())?;
        match (pass.as_ref(), data.as_ref()) {
            (Some(p), Some(d)) => storage::save(p, d).map_err(|e| e.to_string()),
            _ => Err("app is locked".into()),
        }
    }
}

#[tauri::command]
pub fn is_setup() -> Result<bool, String> {
    storage::data_exists().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn setup(passphrase: String, state: State<'_, AppState>) -> Result<(), String> {
    let data = AppData::default();
    storage::save(&passphrase, &data).map_err(|e| e.to_string())?;

    *state.passphrase.lock().map_err(|e| e.to_string())? = Some(passphrase);
    *state.data.lock().map_err(|e| e.to_string())? = Some(data);

    Ok(())
}

#[tauri::command]
pub fn unlock(passphrase: String, state: State<'_, AppState>) -> Result<bool, String> {
    match storage::load(&passphrase) {
        Ok(mut data) => {
            rebuild_cycles(&mut data);
            *state.passphrase.lock().map_err(|e| e.to_string())? = Some(passphrase.clone());
            *state.data.lock().map_err(|e| e.to_string())? = Some(data);
            state.save_data()?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn lock(state: State<'_, AppState>) -> Result<(), String> {
    state.lock();
    Ok(())
}

#[tauri::command]
pub fn log_day(
    date: String,
    flow_level: FlowLevel,
    notes: String,
    symptoms: Vec<(SymptomType, u8)>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let date = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;

    let mut data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_mut().ok_or("app is locked")?;

    // Upsert day log
    if let Some(existing) = data.day_logs.iter_mut().find(|l| l.date == date) {
        existing.flow_level = flow_level.clone();
        existing.notes = notes;
    } else {
        data.day_logs.push(DayLog {
            date,
            flow_level: flow_level.clone(),
            notes,
        });
    }

    // Replace symptoms for this date
    data.symptoms.retain(|s| s.date != date);
    for (symptom_type, severity) in symptoms {
        data.symptoms.push(Symptom {
            date,
            symptom_type,
            severity: severity.clamp(1, 3),
        });
    }

    rebuild_cycles(data);

    drop(data_lock);
    state.save_data()?;
    Ok(())
}

/// Rebuild cycles from flow data.
fn rebuild_cycles(data: &mut AppData) {
    let mut flow_days: Vec<NaiveDate> = data
        .day_logs
        .iter()
        .filter(|l| l.flow_level != FlowLevel::None)
        .map(|l| l.date)
        .collect();
    flow_days.sort();
    flow_days.dedup();

    if flow_days.is_empty() {
        data.cycles.clear();
        return;
    }

    let mut cycles: Vec<Cycle> = Vec::new();
    let mut cycle_start = flow_days[0];
    let mut cycle_end = flow_days[0];

    for &day in &flow_days[1..] {
        if (day - cycle_end).num_days() <= 2 {
            cycle_end = day;
        } else {
            cycles.push(Cycle {
                id: Uuid::new_v4(),
                start_date: cycle_start,
                end_date: Some(cycle_end),
            });
            cycle_start = day;
            cycle_end = day;
        }
    }

    let today = chrono::Local::now().date_naive();
    let last_end = if (today - cycle_end).num_days() <= 2 {
        None
    } else {
        Some(cycle_end)
    };

    cycles.push(Cycle {
        id: Uuid::new_v4(),
        start_date: cycle_start,
        end_date: last_end,
    });

    data.cycles = cycles;
}

#[tauri::command]
pub fn get_month(year: i32, month: u32, state: State<'_, AppState>) -> Result<MonthData, String> {
    let data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_ref().ok_or("app is locked")?;

    let first_day = NaiveDate::from_ymd_opt(year, month, 1).ok_or("invalid date")?;
    let last_day = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .ok_or("invalid date")?
        - chrono::Duration::days(1);

    let day_logs: Vec<DayLog> = data
        .day_logs
        .iter()
        .filter(|l| l.date >= first_day && l.date <= last_day)
        .cloned()
        .collect();

    let symptoms: Vec<Symptom> = data
        .symptoms
        .iter()
        .filter(|s| s.date >= first_day && s.date <= last_day)
        .cloned()
        .collect();

    let predictions: Vec<Prediction> = prediction::predict(&data.cycles).into_iter().collect();

    let fertility = if data.settings.show_fertility {
        prediction::fertility_window(&data.cycles)
    } else {
        None
    };

    let current_cycle = data.cycles.iter().find(|c| c.end_date.is_none()).cloned();
    let stats = prediction::cycle_stats(&data.cycles);

    Ok(MonthData {
        year,
        month,
        day_logs,
        symptoms,
        predictions,
        fertility,
        current_cycle,
        stats,
    })
}

#[tauri::command]
pub fn get_predictions(state: State<'_, AppState>) -> Result<Vec<Prediction>, String> {
    let data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_ref().ok_or("app is locked")?;
    Ok(prediction::predict(&data.cycles).into_iter().collect())
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> Result<CycleStats, String> {
    let data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_ref().ok_or("app is locked")?;
    Ok(prediction::cycle_stats(&data.cycles))
}

#[tauri::command]
pub fn toggle_fertility(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_mut().ok_or("app is locked")?;
    data.settings.show_fertility = enabled;
    drop(data_lock);
    state.save_data()?;
    Ok(())
}

#[tauri::command]
pub fn update_settings(auto_lock_minutes: u32, state: State<'_, AppState>) -> Result<(), String> {
    let mut data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_mut().ok_or("app is locked")?;
    data.settings.auto_lock_minutes = auto_lock_minutes.clamp(1, 60);
    drop(data_lock);
    state.save_data()?;
    Ok(())
}

#[tauri::command]
pub fn export_data(state: State<'_, AppState>) -> Result<String, String> {
    let data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_ref().ok_or("app is locked")?;
    serde_json::to_string_pretty(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wipe_all_data(state: State<'_, AppState>) -> Result<(), String> {
    state.lock();
    storage::wipe().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let data_lock = state.data.lock().map_err(|e| e.to_string())?;
    let data = data_lock.as_ref().ok_or("app is locked")?;
    Ok(data.settings.clone())
}
