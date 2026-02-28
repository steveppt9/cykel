// ============================================
// Cykel PWA — App (no server, no Tauri)
// ============================================

import * as storage from './storage.js';
import { rebuildCycles, predict, fertilityWindow, cycleStats, fmtDate } from './prediction.js';

// ============================================
// State
// ============================================

let passphrase = null;  // held in memory only while unlocked
let appData = null;
let currentYear, currentMonth;
let selectedFlow = 'None';
let selectedSymptoms = new Set();
let selectedDate = null;
let autoLockTimer = null;
let autoLockMinutes = 5;
let showFertility = false;

// Default app data structure
function defaultAppData() {
  return {
    cycles: [],
    day_logs: [],
    symptoms: [],
    settings: { auto_lock_minutes: 5, show_fertility: false },
  };
}

// ============================================
// Persistence helpers
// ============================================

async function saveData() {
  if (!passphrase || !appData) return;
  await storage.save(passphrase, appData);
}

// ============================================
// Screen management
// ============================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.style.display = 'none';
    s.style.animation = 'none';
  });
  const screen = document.getElementById(`screen-${id}`);
  screen.style.display = 'block';
  screen.offsetHeight;
  screen.style.animation = '';
}

// ============================================
// Init
// ============================================

async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const exists = await storage.dataExists();
  showScreen(exists ? 'unlock' : 'setup');
}

// ============================================
// Setup
// ============================================

const setupPass = document.getElementById('setup-pass');
const setupConfirm = document.getElementById('setup-confirm');
const btnSetup = document.getElementById('btn-setup');
const setupError = document.getElementById('setup-error');

function validateSetup() {
  btnSetup.disabled = setupPass.value.length < 6 || setupPass.value !== setupConfirm.value;
}

setupPass.addEventListener('input', validateSetup);
setupConfirm.addEventListener('input', validateSetup);
setupPass.addEventListener('keydown', e => { if (e.key === 'Enter') setupConfirm.focus(); });
setupConfirm.addEventListener('keydown', e => { if (e.key === 'Enter' && !btnSetup.disabled) btnSetup.click(); });

btnSetup.addEventListener('click', async () => {
  setupError.textContent = '';
  btnSetup.disabled = true;
  try {
    passphrase = setupPass.value;
    appData = defaultAppData();
    await saveData();
    setupPass.value = '';
    setupConfirm.value = '';
    enterApp();
  } catch (e) {
    setupError.textContent = 'Something went wrong. Try again.';
    btnSetup.disabled = false;
    passphrase = null;
    appData = null;
  }
});

// ============================================
// Unlock
// ============================================

const unlockPass = document.getElementById('unlock-pass');
const btnUnlock = document.getElementById('btn-unlock');
const unlockError = document.getElementById('unlock-error');

btnUnlock.addEventListener('click', async () => {
  const pass = unlockPass.value;
  unlockError.textContent = '';
  if (!pass) return;
  btnUnlock.disabled = true;

  try {
    appData = await storage.load(pass);
    passphrase = pass;

    // Ensure settings exist (migration from older data)
    if (!appData.settings) appData.settings = defaultAppData().settings;

    // Rebuild cycles
    appData.cycles = rebuildCycles(appData.day_logs);
    await saveData();

    unlockPass.value = '';
    enterApp();
  } catch (e) {
    unlockError.textContent = 'Wrong passphrase';
    unlockPass.value = '';
    unlockPass.focus();
    const wrap = unlockPass.parentElement;
    wrap.style.animation = 'shake 400ms ease';
    setTimeout(() => wrap.style.animation = '', 400);
  }
  btnUnlock.disabled = false;
});

unlockPass.addEventListener('keydown', e => { if (e.key === 'Enter') btnUnlock.click(); });

// ============================================
// App entry
// ============================================

function enterApp() {
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;

  autoLockMinutes = appData.settings.auto_lock_minutes || 5;
  showFertility = appData.settings.show_fertility || false;
  document.getElementById('setting-autolock').textContent = `${autoLockMinutes} min`;
  document.getElementById('toggle-fertility').checked = showFertility;
  document.getElementById('legend-fertile').style.display = showFertility ? 'flex' : 'none';

  showScreen('calendar');
  renderCalendar();
  resetAutoLock();
}

// ============================================
// Auto-lock
// ============================================

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(doLock, autoLockMinutes * 60 * 1000);
}

document.addEventListener('pointerdown', resetAutoLock);
document.addEventListener('keydown', resetAutoLock);

// Lock on visibility change (phone screen off / tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && passphrase) {
    doLock();
  }
});

function doLock() {
  clearTimeout(autoLockTimer);
  passphrase = null;
  appData = null;
  showScreen('unlock');
}

// ============================================
// Calendar
// ============================================

const monthTitle = document.getElementById('month-title');
const monthYear = document.getElementById('month-year');
const calendarGrid = document.getElementById('calendar-grid');
const predictionCard = document.getElementById('prediction-card');
const predictionText = document.getElementById('prediction-text');
const fertilityCard = document.getElementById('fertility-card');
const fertilityText = document.getElementById('fertility-text');
const emptyState = document.getElementById('empty-state');
const cycleLegend = document.getElementById('cycle-legend');

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

document.getElementById('btn-prev-month').addEventListener('click', () => {
  currentMonth--;
  if (currentMonth < 1) { currentMonth = 12; currentYear--; }
  renderCalendar();
});

document.getElementById('btn-next-month').addEventListener('click', () => {
  currentMonth++;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  renderCalendar();
});

function renderCalendar() {
  if (!appData) return;

  monthTitle.textContent = MONTH_NAMES[currentMonth];
  monthYear.textContent = currentYear;
  document.querySelectorAll('.cal-day').forEach(el => el.remove());

  // Lookups
  const logMap = {};
  appData.day_logs.forEach(l => { logMap[l.date] = l; });

  const symptomMap = {};
  appData.symptoms.forEach(s => {
    if (!symptomMap[s.date]) symptomMap[s.date] = [];
    symptomMap[s.date].push(s);
  });

  // Predictions
  const pred = predict(appData.cycles);
  const predDates = new Set();
  if (pred) {
    let d = new Date(pred.predicted_start + 'T00:00:00');
    const end = new Date(pred.predicted_end + 'T00:00:00');
    while (d <= end) {
      predDates.add(fmtDate(d));
      d.setDate(d.getDate() + 1);
    }
  }

  // Fertility
  const fertileDates = new Set();
  const peakDates = new Set();
  let ovulationDate = null;
  const fw = showFertility ? fertilityWindow(appData.cycles) : null;

  if (fw) {
    let d = new Date(fw.fertile_start + 'T00:00:00');
    const end = new Date(fw.fertile_end + 'T00:00:00');
    while (d <= end) {
      fertileDates.add(fmtDate(d));
      d.setDate(d.getDate() + 1);
    }
    let pk = new Date(fw.peak_start + 'T00:00:00');
    const pkEnd = new Date(fw.peak_end + 'T00:00:00');
    while (pk <= pkEnd) {
      peakDates.add(fmtDate(pk));
      pk.setDate(pk.getDate() + 1);
    }
    ovulationDate = fw.ovulation_day;
  }

  // UI state
  const hasData = appData.day_logs.length > 0 || pred != null;
  emptyState.style.display = hasData ? 'none' : 'block';
  cycleLegend.style.display = hasData ? 'flex' : 'none';

  if (pred) {
    predictionCard.style.display = 'flex';
    predictionText.textContent = fmtDatePretty(pred.predicted_start);
  } else {
    predictionCard.style.display = 'none';
  }

  if (fw) {
    fertilityCard.style.display = 'flex';
    fertilityText.textContent = `${fmtDateShort(fw.fertile_start)} - ${fmtDateShort(fw.fertile_end)}`;
  } else {
    fertilityCard.style.display = 'none';
  }

  // Build grid
  const firstDay = new Date(currentYear, currentMonth - 1, 1);
  const lastDay = new Date(currentYear, currentMonth, 0);
  const startDow = firstDay.getDay();
  const todayStr = fmtDate(new Date());

  for (let i = 0; i < startDow; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day is-empty';
    calendarGrid.appendChild(cell);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.textContent = d;

    if (dateStr === todayStr) cell.classList.add('is-today');

    const log = logMap[dateStr];
    const hasFlow = log && log.flow_level !== 'None';

    if (hasFlow) cell.classList.add(`flow-${log.flow_level.toLowerCase()}`);

    if (!hasFlow) {
      if (fertileDates.has(dateStr)) {
        if (dateStr === ovulationDate) cell.classList.add('is-ovulation');
        else if (peakDates.has(dateStr)) cell.classList.add('is-peak');
        else cell.classList.add('is-fertile');
      }
      if (predDates.has(dateStr)) cell.classList.add('is-predicted');
    }

    if (symptomMap[dateStr]) cell.classList.add('has-symptoms');

    cell.addEventListener('click', () => openDayLog(dateStr, log, symptomMap[dateStr]));
    calendarGrid.appendChild(cell);
  }
}

function fmtDatePretty(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ============================================
// Day Log
// ============================================

const daylogTitle = document.getElementById('daylog-title');
const daylogNotes = document.getElementById('daylog-notes');

function openDayLog(dateStr, existingLog, existingSymptoms) {
  selectedDate = dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  daylogTitle.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  selectedFlow = existingLog ? existingLog.flow_level : 'None';
  selectedSymptoms = new Set();
  if (existingSymptoms) existingSymptoms.forEach(s => selectedSymptoms.add(s.symptom_type));
  daylogNotes.value = existingLog ? existingLog.notes : '';

  updateFlowButtons();
  updateSymptomChips();
  showScreen('daylog');
}

function updateFlowButtons() {
  document.querySelectorAll('.flow-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.flow === selectedFlow);
  });
}

function updateSymptomChips() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.classList.toggle('active', selectedSymptoms.has(chip.dataset.symptom));
  });
}

document.getElementById('flow-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.flow-opt');
  if (!btn) return;
  selectedFlow = btn.dataset.flow;
  updateFlowButtons();
});

document.getElementById('symptom-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const sym = chip.dataset.symptom;
  if (selectedSymptoms.has(sym)) selectedSymptoms.delete(sym);
  else selectedSymptoms.add(sym);
  updateSymptomChips();
});

document.getElementById('btn-save-day').addEventListener('click', async () => {
  if (!selectedDate || !appData) return;

  // Upsert day log
  const existing = appData.day_logs.find(l => l.date === selectedDate);
  if (existing) {
    existing.flow_level = selectedFlow;
    existing.notes = daylogNotes.value;
  } else {
    appData.day_logs.push({ date: selectedDate, flow_level: selectedFlow, notes: daylogNotes.value });
  }

  // Replace symptoms for this date
  appData.symptoms = appData.symptoms.filter(s => s.date !== selectedDate);
  for (const sym of selectedSymptoms) {
    appData.symptoms.push({ date: selectedDate, symptom_type: sym, severity: 2 });
  }

  // Rebuild cycles
  appData.cycles = rebuildCycles(appData.day_logs);

  await saveData();
  showScreen('calendar');
  renderCalendar();
});

document.getElementById('btn-back').addEventListener('click', () => showScreen('calendar'));

// ============================================
// Stats
// ============================================

document.getElementById('btn-stats').addEventListener('click', () => {
  if (!appData) return;
  showScreen('stats');

  const stats = cycleStats(appData.cycles);
  const hasStats = stats.total_cycles >= 2 && stats.avg_cycle_length != null;

  document.getElementById('stats-empty').style.display = hasStats ? 'none' : 'block';
  document.getElementById('stats-content').style.display = hasStats ? 'block' : 'none';

  if (hasStats) {
    document.getElementById('stat-avg-cycle').textContent = `${Math.round(stats.avg_cycle_length)}d`;
    document.getElementById('stat-avg-period').textContent = `${Math.round(stats.avg_period_length)}d`;
    document.getElementById('stat-shortest').textContent = stats.shortest_cycle != null ? `${stats.shortest_cycle}d` : '--';
    document.getElementById('stat-longest').textContent = stats.longest_cycle != null ? `${stats.longest_cycle}d` : '--';
    document.getElementById('stat-total').textContent = stats.total_cycles;
    document.getElementById('stat-last-start').textContent = stats.last_period_start ? fmtDatePretty(stats.last_period_start) : '--';
    document.getElementById('stat-last-end').textContent = stats.last_period_end ? fmtDatePretty(stats.last_period_end) : '--';
  }
});

document.getElementById('btn-stats-back').addEventListener('click', () => showScreen('calendar'));

// ============================================
// Settings
// ============================================

document.getElementById('btn-settings').addEventListener('click', () => showScreen('settings'));
document.getElementById('btn-settings-back').addEventListener('click', () => showScreen('calendar'));
document.getElementById('btn-lock').addEventListener('click', doLock);

// Fertility toggle
document.getElementById('toggle-fertility').addEventListener('change', async (e) => {
  showFertility = e.target.checked;
  document.getElementById('legend-fertile').style.display = showFertility ? 'flex' : 'none';
  if (appData) {
    appData.settings.show_fertility = showFertility;
    await saveData();
  }
});

// Auto-lock stepper
const autolockDisplay = document.getElementById('setting-autolock');

document.getElementById('autolock-down').addEventListener('click', async () => {
  if (autoLockMinutes > 1) {
    autoLockMinutes--;
    autolockDisplay.textContent = `${autoLockMinutes} min`;
    resetAutoLock();
    if (appData) { appData.settings.auto_lock_minutes = autoLockMinutes; await saveData(); }
  }
});

document.getElementById('autolock-up').addEventListener('click', async () => {
  if (autoLockMinutes < 60) {
    autoLockMinutes++;
    autolockDisplay.textContent = `${autoLockMinutes} min`;
    resetAutoLock();
    if (appData) { appData.settings.auto_lock_minutes = autoLockMinutes; await saveData(); }
  }
});

// Export
document.getElementById('btn-export').addEventListener('click', () => {
  if (!appData) return;
  const json = JSON.stringify(appData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cykel-export-${fmtDate(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Wipe
document.getElementById('btn-wipe').addEventListener('click', async () => {
  if (!confirm('Are you sure? This permanently deletes all your data.')) return;
  if (!confirm('Really sure? There is no way to undo this.')) return;
  await storage.wipe();
  passphrase = null;
  appData = null;
  showScreen('setup');
});

// ============================================
// Shake animation
// ============================================

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(shakeStyle);

// ============================================
// Boot
// ============================================

init();
