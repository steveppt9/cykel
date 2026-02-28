use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FlowLevel {
    None,
    Light,
    Medium,
    Heavy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SymptomType {
    Cramps,
    Headache,
    MoodLow,
    MoodHigh,
    Fatigue,
    Bloating,
    BreastTenderness,
    Acne,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Cycle {
    pub id: Uuid,
    pub start_date: NaiveDate,
    pub end_date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayLog {
    pub date: NaiveDate,
    pub flow_level: FlowLevel,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symptom {
    pub date: NaiveDate,
    pub symptom_type: SymptomType,
    pub severity: u8, // 1-3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prediction {
    pub predicted_start: NaiveDate,
    pub predicted_end: NaiveDate,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FertilityWindow {
    pub fertile_start: NaiveDate,
    pub fertile_end: NaiveDate,
    pub ovulation_day: NaiveDate,
    pub peak_start: NaiveDate,
    pub peak_end: NaiveDate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CycleStats {
    pub total_cycles: usize,
    pub avg_cycle_length: Option<f32>,
    pub avg_period_length: Option<f32>,
    pub shortest_cycle: Option<i64>,
    pub longest_cycle: Option<i64>,
    pub last_period_start: Option<NaiveDate>,
    pub last_period_end: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub cycles: Vec<Cycle>,
    pub day_logs: Vec<DayLog>,
    pub symptoms: Vec<Symptom>,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub auto_lock_minutes: u32,
    pub wipe_after_attempts: Option<u32>,
    #[serde(default)]
    pub show_fertility: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 5,
            wipe_after_attempts: None,
            show_fertility: false,
        }
    }
}

/// Data returned to frontend for a month view
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthData {
    pub year: i32,
    pub month: u32,
    pub day_logs: Vec<DayLog>,
    pub symptoms: Vec<Symptom>,
    pub predictions: Vec<Prediction>,
    pub fertility: Option<FertilityWindow>,
    pub current_cycle: Option<Cycle>,
    pub stats: CycleStats,
}
