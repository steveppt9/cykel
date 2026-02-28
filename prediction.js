// ============================================
// Cykel PWA — Prediction Engine
// Port of src-tauri/src/prediction.rs
// ============================================

/**
 * Parse "YYYY-MM-DD" to Date (local midnight).
 */
function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Format Date to "YYYY-MM-DD".
 */
export function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Days between two date strings.
 */
function daysBetween(a, b) {
  const da = typeof a === 'string' ? parseDate(a) : a;
  const db = typeof b === 'string' ? parseDate(b) : b;
  return Math.round((db - da) / 86400000);
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Rebuild cycles from day logs.
 * Groups consecutive flow days (gap <= 2 days) into cycles.
 */
export function rebuildCycles(dayLogs) {
  const flowDays = dayLogs
    .filter(l => l.flow_level !== 'None')
    .map(l => l.date)
    .sort();

  // Deduplicate
  const unique = [...new Set(flowDays)];
  if (!unique.length) return [];

  const cycles = [];
  let start = unique[0];
  let end = unique[0];

  for (let i = 1; i < unique.length; i++) {
    const gap = daysBetween(end, unique[i]);
    if (gap <= 2) {
      end = unique[i];
    } else {
      cycles.push({ start_date: start, end_date: end });
      start = unique[i];
      end = unique[i];
    }
  }

  // Last cycle: if most recent flow was within 2 days of today, leave open
  const today = fmtDate(new Date());
  const daysAgo = daysBetween(end, today);
  cycles.push({
    start_date: start,
    end_date: daysAgo <= 2 ? null : end,
  });

  return cycles;
}

/**
 * Predict next period.
 * Requires >= 2 completed cycles.
 */
export function predict(cycles) {
  const completed = cycles
    .filter(c => c.end_date != null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (completed.length < 2) return null;

  const recent = completed.slice(-6);

  const cycleLengths = [];
  for (let i = 1; i < recent.length; i++) {
    cycleLengths.push(daysBetween(recent[i - 1].start_date, recent[i].start_date));
  }
  if (!cycleLengths.length) return null;

  const periodLengths = recent.map(c => daysBetween(c.start_date, c.end_date) + 1);

  const avgCycle = mean(cycleLengths);
  const avgPeriod = periodLengths.length ? mean(periodLengths) : 5;
  const lastStart = completed[completed.length - 1].start_date;

  const predictedStart = addDays(lastStart, Math.round(avgCycle));
  const predictedEnd = addDays(predictedStart, Math.max(0, Math.round(avgPeriod) - 1));

  const sd = stdDev(cycleLengths);
  const confidence = Math.max(0.1, Math.min(0.95, 1 - sd / avgCycle));

  return { predicted_start: predictedStart, predicted_end: predictedEnd, confidence };
}

/**
 * Estimate fertility window.
 * Ovulation ~14 days before predicted period. Fertile = ovulation - 5 to ovulation.
 */
export function fertilityWindow(cycles) {
  const pred = predict(cycles);
  if (!pred) return null;

  const ovulationDay = addDays(pred.predicted_start, -14);
  const fertileStart = addDays(ovulationDay, -5);
  const peakStart = addDays(ovulationDay, -2);

  return {
    fertile_start: fertileStart,
    fertile_end: ovulationDay,
    ovulation_day: ovulationDay,
    peak_start: peakStart,
    peak_end: ovulationDay,
  };
}

/**
 * Compute cycle statistics.
 */
export function cycleStats(cycles) {
  const completed = cycles
    .filter(c => c.end_date != null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (!completed.length) {
    return {
      total_cycles: 0,
      avg_cycle_length: null,
      avg_period_length: null,
      shortest_cycle: null,
      longest_cycle: null,
      last_period_start: null,
      last_period_end: null,
    };
  }

  const periodLengths = completed.map(c => daysBetween(c.start_date, c.end_date) + 1);

  const cycleLengths = [];
  for (let i = 1; i < completed.length; i++) {
    cycleLengths.push(daysBetween(completed[i - 1].start_date, completed[i].start_date));
  }

  const last = completed[completed.length - 1];

  return {
    total_cycles: completed.length,
    avg_cycle_length: cycleLengths.length ? mean(cycleLengths) : null,
    avg_period_length: periodLengths.length ? mean(periodLengths) : null,
    shortest_cycle: cycleLengths.length ? Math.min(...cycleLengths) : null,
    longest_cycle: cycleLengths.length ? Math.max(...cycleLengths) : null,
    last_period_start: last.start_date,
    last_period_end: last.end_date,
  };
}
