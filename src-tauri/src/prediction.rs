use crate::models::{Cycle, CycleStats, FertilityWindow, Prediction};

/// Generate period predictions based on completed cycles.
/// Requires at least 2 completed cycles.
pub fn predict(cycles: &[Cycle]) -> Option<Prediction> {
    let stats = calc_internals(cycles)?;

    let predicted_start =
        stats.last_start + chrono::Duration::days(stats.avg_cycle.round() as i64);
    let predicted_end =
        predicted_start + chrono::Duration::days((stats.avg_period.round() - 1.0).max(0.0) as i64);

    let confidence = if stats.cycle_lengths.len() < 2 {
        0.5
    } else {
        let std_dev = std_deviation(&stats.cycle_lengths);
        (1.0 - (std_dev / stats.avg_cycle) as f32).clamp(0.1, 0.95)
    };

    Some(Prediction {
        predicted_start,
        predicted_end,
        confidence,
    })
}

/// Estimate the fertility window based on predicted next period.
/// Ovulation ~14 days before next period. Fertile window = ovulation - 5 to ovulation day.
/// Peak fertility = ovulation - 2 to ovulation day.
pub fn fertility_window(cycles: &[Cycle]) -> Option<FertilityWindow> {
    let prediction = predict(cycles)?;

    // Ovulation estimated at 14 days before predicted period start
    let ovulation_day = prediction.predicted_start - chrono::Duration::days(14);
    let fertile_start = ovulation_day - chrono::Duration::days(5);
    let fertile_end = ovulation_day;
    let peak_start = ovulation_day - chrono::Duration::days(2);
    let peak_end = ovulation_day;

    Some(FertilityWindow {
        fertile_start,
        fertile_end,
        ovulation_day,
        peak_start,
        peak_end,
    })
}

/// Compute cycle statistics for the stats view.
pub fn cycle_stats(cycles: &[Cycle]) -> CycleStats {
    let mut completed: Vec<&Cycle> = cycles.iter().filter(|c| c.end_date.is_some()).collect();
    completed.sort_by_key(|c| c.start_date);

    if completed.is_empty() {
        return CycleStats {
            total_cycles: 0,
            avg_cycle_length: None,
            avg_period_length: None,
            shortest_cycle: None,
            longest_cycle: None,
            last_period_start: None,
            last_period_end: None,
        };
    }

    let period_lengths: Vec<f64> = completed
        .iter()
        .filter_map(|c| c.end_date.map(|end| (end - c.start_date).num_days() as f64 + 1.0))
        .collect();

    let cycle_lengths: Vec<i64> = completed
        .windows(2)
        .map(|w| (w[1].start_date - w[0].start_date).num_days())
        .collect();

    let last = completed.last().unwrap();

    CycleStats {
        total_cycles: completed.len(),
        avg_cycle_length: if cycle_lengths.is_empty() {
            None
        } else {
            Some(cycle_lengths.iter().sum::<i64>() as f32 / cycle_lengths.len() as f32)
        },
        avg_period_length: if period_lengths.is_empty() {
            None
        } else {
            Some(period_lengths.iter().sum::<f64>() as f32 / period_lengths.len() as f32)
        },
        shortest_cycle: cycle_lengths.iter().copied().min(),
        longest_cycle: cycle_lengths.iter().copied().max(),
        last_period_start: Some(last.start_date),
        last_period_end: last.end_date,
    }
}

struct PredictionInternals {
    avg_cycle: f64,
    avg_period: f64,
    cycle_lengths: Vec<f64>,
    last_start: chrono::NaiveDate,
}

fn calc_internals(cycles: &[Cycle]) -> Option<PredictionInternals> {
    let mut completed: Vec<&Cycle> = cycles.iter().filter(|c| c.end_date.is_some()).collect();

    if completed.len() < 2 {
        return None;
    }

    completed.sort_by_key(|c| c.start_date);

    // Use last 6 cycles max
    let recent: Vec<&Cycle> = completed.iter().rev().take(6).copied().collect();

    let cycle_lengths: Vec<f64> = recent
        .windows(2)
        .map(|w| (w[0].start_date - w[1].start_date).num_days().unsigned_abs() as f64)
        .collect();

    if cycle_lengths.is_empty() {
        return None;
    }

    let period_lengths: Vec<f64> = recent
        .iter()
        .filter_map(|c| c.end_date.map(|end| (end - c.start_date).num_days() as f64 + 1.0))
        .collect();

    let avg_cycle = mean(&cycle_lengths);
    let avg_period = if period_lengths.is_empty() {
        5.0
    } else {
        mean(&period_lengths)
    };

    let last_start = completed.last().unwrap().start_date;

    Some(PredictionInternals {
        avg_cycle,
        avg_period,
        cycle_lengths,
        last_start,
    })
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn std_deviation(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let avg = mean(values);
    let variance =
        values.iter().map(|v| (v - avg).powi(2)).sum::<f64>() / (values.len() - 1) as f64;
    variance.sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use uuid::Uuid;

    fn make_cycle(start: &str, end: &str) -> Cycle {
        Cycle {
            id: Uuid::new_v4(),
            start_date: NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap(),
            end_date: Some(NaiveDate::parse_from_str(end, "%Y-%m-%d").unwrap()),
        }
    }

    #[test]
    fn no_prediction_with_one_cycle() {
        let cycles = vec![make_cycle("2026-01-01", "2026-01-05")];
        assert!(predict(&cycles).is_none());
    }

    #[test]
    fn predicts_with_two_cycles() {
        let cycles = vec![
            make_cycle("2026-01-01", "2026-01-05"),
            make_cycle("2026-01-29", "2026-02-02"),
        ];
        let pred = predict(&cycles).unwrap();
        assert_eq!(
            pred.predicted_start,
            NaiveDate::from_ymd_opt(2026, 2, 26).unwrap()
        );
    }

    #[test]
    fn fertility_window_calculated() {
        let cycles = vec![
            make_cycle("2026-01-01", "2026-01-05"),
            make_cycle("2026-01-29", "2026-02-02"),
        ];
        let fw = fertility_window(&cycles).unwrap();
        // Predicted period: Feb 26. Ovulation: Feb 26 - 14 = Feb 12
        assert_eq!(
            fw.ovulation_day,
            NaiveDate::from_ymd_opt(2026, 2, 12).unwrap()
        );
        // Fertile window: Feb 7 - Feb 12
        assert_eq!(
            fw.fertile_start,
            NaiveDate::from_ymd_opt(2026, 2, 7).unwrap()
        );
    }

    #[test]
    fn cycle_stats_computed() {
        let cycles = vec![
            make_cycle("2026-01-01", "2026-01-05"),
            make_cycle("2026-01-29", "2026-02-02"),
        ];
        let stats = cycle_stats(&cycles);
        assert_eq!(stats.total_cycles, 2);
        assert_eq!(stats.avg_cycle_length, Some(28.0));
        assert_eq!(stats.avg_period_length, Some(5.0));
    }
}
