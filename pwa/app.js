// ============================================
// Cykel PWA — App v3 (PIN + passphrase + biometric unlock)
// ============================================

import * as storage from './storage.js';
import { zeroize } from './crypto.js';
import { rebuildCycles, predict, fertilityWindow, cycleStats, fmtDate } from './prediction.js';

// ============================================
// Install prompt
// ============================================

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

function isMobile() {
  return isIOS() || isAndroid() || /mobile/i.test(navigator.userAgent);
}

function shouldShowInstall() {
  if (isStandalone()) return false;
  if (localStorage.getItem('cykel_skip_install')) return false;
  return true;
}

function showInstallPrompt() {
  document.getElementById('install-ios').classList.add('hidden');
  document.getElementById('install-android').classList.add('hidden');
  document.getElementById('install-desktop').classList.add('hidden');

  showScreen('install');

  if (isIOS()) {
    document.getElementById('install-ios').classList.remove('hidden');
  } else if (deferredInstallPrompt || isAndroid()) {
    document.getElementById('install-android').classList.remove('hidden');
  } else if (!isMobile()) {
    document.getElementById('install-desktop').classList.remove('hidden');
  } else {
    document.getElementById('install-android').classList.remove('hidden');
  }
}

document.getElementById('btn-android-install').addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (result.outcome === 'accepted') skipInstallScreen();
  } else {
    document.getElementById('install-android').innerHTML = `
      <div class="install-how">
        <div class="step"><div class="step-num">1</div><div class="step-content"><span class="step-text">Tap the <strong>menu</strong> button (three dots)</span></div></div>
        <div class="step"><div class="step-num">2</div><div class="step-content"><span class="step-text">Tap <strong>Add to Home screen</strong></span></div></div>
        <div class="step"><div class="step-num">3</div><div class="step-content"><span class="step-text">Tap <strong>Add</strong> — that's it</span></div></div>
      </div>`;
  }
});

document.getElementById('btn-skip-install').addEventListener('click', skipInstallScreen);

function skipInstallScreen() {
  localStorage.setItem('cykel_skip_install', '1');
  startApp();
}

// ============================================
// State
// ============================================

let masterKeyBytes = null; // Uint8Array(32) — zeroed on lock
let appData = null;
let pinEnabled = false;    // cached flag
let bioEnabled = false;    // cached flag
let bioTriedThisLock = false; // prevent auto-prompt loop
let currentYear, currentMonth;
let selectedFlow = 'None';
let selectedSymptoms = new Set();
let selectedDate = null;
let autoLockTimer = null;
let autoLockMinutes = 5;
let showFertility = false;

function defaultAppData() {
  return {
    cycles: [], day_logs: [], symptoms: [],
    settings: { auto_lock_minutes: 5, show_fertility: false },
  };
}

// ============================================
// Persistence
// ============================================

async function saveData() {
  if (!masterKeyBytes || !appData) return;
  await storage.save(masterKeyBytes, appData);
}

// ============================================
// Screen management
// ============================================

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const screen = document.getElementById(`screen-${id}`);
  screen.classList.remove('hidden');
  screen.offsetHeight;
}

// ============================================
// Init
// ============================================

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (shouldShowInstall()) {
    showInstallPrompt();
  } else {
    startApp();
  }
}

async function startApp() {
  const exists = await storage.dataExists();
  if (!exists) {
    showScreen('setup');
    return;
  }
  pinEnabled = await storage.hasPin();
  bioEnabled = await storage.hasBio();
  bioTriedThisLock = false;

  if (pinEnabled) {
    resetPinDots('pin-unlock-dots');
    showScreen('pin-unlock');
  } else {
    showScreen('unlock');
  }
  showBioButtons();

  // Auto-trigger biometric if available
  if (bioEnabled) {
    bioTriedThisLock = true;
    setTimeout(() => attemptBioUnlock(), 300);
  }
}

// ============================================
// Setup (passphrase)
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
    const result = await storage.setup(setupPass.value);
    setupPass.value = '';
    setupConfirm.value = '';
    masterKeyBytes = result.masterKeyBytes;
    appData = result.data;
    // Prompt to set PIN
    showPinSetup();
  } catch (e) {
    setupError.textContent = 'Something went wrong. Try again.';
    btnSetup.disabled = false;
    masterKeyBytes = null;
    appData = null;
  }
});

// ============================================
// PIN pad shared logic
// ============================================

const PIN_LENGTH = 4;

function createPinPadHandler(dotsId, padId, onComplete) {
  let digits = '';
  const dotsEl = document.getElementById(dotsId);
  const padEl = document.getElementById(padId);

  function updateDots() {
    const dots = dotsEl.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < digits.length);
    });
  }

  function reset() {
    digits = '';
    updateDots();
  }

  function shake() {
    const dots = dotsEl.querySelectorAll('.pin-dot');
    dots.forEach(d => d.classList.add('error'));
    setTimeout(() => {
      dots.forEach(d => d.classList.remove('error'));
      reset();
    }, 500);
  }

  padEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn || btn.classList.contains('pin-key-empty')) return;

    const key = btn.dataset.key;
    if (key === 'delete') {
      digits = digits.slice(0, -1);
      updateDots();
      return;
    }

    if (digits.length >= PIN_LENGTH) return;
    digits += key;
    updateDots();

    if (digits.length === PIN_LENGTH) {
      const pin = digits;
      setTimeout(() => onComplete(pin, reset, shake), 150);
    }
  });

  return { reset, shake };
}

function resetPinDots(dotsId) {
  const dots = document.getElementById(dotsId).querySelectorAll('.pin-dot');
  dots.forEach(d => {
    d.classList.remove('filled', 'error');
  });
}

// ============================================
// PIN setup (after passphrase creation / from settings)
// ============================================

let pinSetupFirstEntry = '';
let pinSetupHandler = null;

function showPinSetup() {
  pinSetupFirstEntry = '';
  document.getElementById('pin-setup-title').textContent = 'Set a PIN';
  document.getElementById('pin-setup-subtitle').textContent = 'For quick daily unlock';
  document.getElementById('pin-setup-error').textContent = '';
  resetPinDots('pin-setup-dots');
  showScreen('pin-setup');

  if (!pinSetupHandler) {
    pinSetupHandler = createPinPadHandler('pin-setup-dots', 'pin-setup-pad', handlePinSetupComplete);
  } else {
    pinSetupHandler.reset();
  }
}

async function handlePinSetupComplete(pin, reset, shake) {
  if (!pinSetupFirstEntry) {
    // First entry — ask to confirm
    pinSetupFirstEntry = pin;
    document.getElementById('pin-setup-title').textContent = 'Confirm PIN';
    document.getElementById('pin-setup-subtitle').textContent = 'Enter the same PIN again';
    reset();
    return;
  }

  // Second entry — verify match
  if (pin !== pinSetupFirstEntry) {
    document.getElementById('pin-setup-error').textContent = 'PINs didn\'t match. Try again.';
    pinSetupFirstEntry = '';
    document.getElementById('pin-setup-title').textContent = 'Set a PIN';
    document.getElementById('pin-setup-subtitle').textContent = 'For quick daily unlock';
    shake();
    return;
  }

  // Match! Save PIN
  document.getElementById('pin-setup-error').textContent = '';
  await storage.setupPin(masterKeyBytes, pin);
  pinEnabled = true;
  pinSetupFirstEntry = '';
  enterApp();
}

document.getElementById('btn-skip-pin').addEventListener('click', () => {
  pinSetupFirstEntry = '';
  enterApp();
});

// ============================================
// PIN unlock
// ============================================

const pinUnlockError = document.getElementById('pin-unlock-error');
const MAX_PIN_ATTEMPTS = 3;

function getFailedPinAttempts() {
  return parseInt(localStorage.getItem('cykel_pin_fails') || '0', 10);
}

function setFailedPinAttempts(n) {
  localStorage.setItem('cykel_pin_fails', String(n));
}

let pinUnlockHandler = null;

function initPinUnlock() {
  if (!pinUnlockHandler) {
    pinUnlockHandler = createPinPadHandler('pin-unlock-dots', 'pin-unlock-pad', handlePinUnlock);
  }
}

initPinUnlock();

async function handlePinUnlock(pin, reset, shake) {
  pinUnlockError.textContent = '';
  try {
    const result = await storage.unlockWithPin(pin);
    masterKeyBytes = result.masterKeyBytes;
    appData = result.data;
    setFailedPinAttempts(0);
    clearLockout();

    if (!appData.settings) appData.settings = defaultAppData().settings;
    appData.cycles = rebuildCycles(appData.day_logs);
    await saveData();
    enterApp();
  } catch (e) {
    const attempts = getFailedPinAttempts() + 1;
    setFailedPinAttempts(attempts);

    if (attempts >= MAX_PIN_ATTEMPTS) {
      // PIN locked out — require passphrase
      pinUnlockError.textContent = '';
      setFailedPinAttempts(0);
      showScreen('unlock');
      return;
    }

    const remaining = MAX_PIN_ATTEMPTS - attempts;
    pinUnlockError.textContent = `Wrong PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`;
    shake();
  }
}

document.getElementById('btn-use-passphrase').addEventListener('click', () => {
  showScreen('unlock');
  showBioButtons();
});

// ============================================
// Biometric (WebAuthn PRF)
// ============================================

const BIO_PRF_SALT = new TextEncoder().encode('cykel-biometric-v1');

async function isBioSupported() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

async function registerBioCredential() {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Cykel' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'cykel-user',
        displayName: 'Cykel User',
      },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },
        { alg: -257, type: 'public-key' },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      extensions: { prf: {} },
    },
  });

  const prfEnabled = credential.getClientExtensionResults()?.prf?.enabled;
  if (!prfEnabled) {
    throw new Error('PRF not supported');
  }

  const credentialId = new Uint8Array(credential.rawId);
  const prfOutput = await getBioPrfOutput(credentialId);
  return { credentialId, prfOutput };
}

async function getBioPrfOutput(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{
        id: credentialId,
        type: 'public-key',
        transports: ['internal'],
      }],
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: BIO_PRF_SALT } },
      },
    },
  });

  const prfOutput = assertion.getClientExtensionResults()?.prf?.results?.first;
  if (!prfOutput) throw new Error('PRF output missing');
  return new Uint8Array(prfOutput);
}

async function attemptBioUnlock() {
  try {
    const credentialId = await storage.getBioCredentialId();
    if (!credentialId) return false;

    const prfOutput = await getBioPrfOutput(credentialId);
    const result = await storage.unlockWithBio(prfOutput);
    masterKeyBytes = result.masterKeyBytes;
    appData = result.data;
    clearLockout();

    if (!appData.settings) appData.settings = defaultAppData().settings;
    appData.cycles = rebuildCycles(appData.day_logs);
    await saveData();
    enterApp();
    return true;
  } catch {
    return false;
  }
}

function showBioButtons() {
  document.getElementById('btn-bio-pin').classList.toggle('hidden', !bioEnabled);
  document.getElementById('btn-bio-pass').classList.toggle('hidden', !bioEnabled);
}

document.getElementById('btn-bio-pin').addEventListener('click', () => attemptBioUnlock());
document.getElementById('btn-bio-pass').addEventListener('click', () => attemptBioUnlock());

// ============================================
// Passphrase unlock
// ============================================

const unlockPass = document.getElementById('unlock-pass');
const btnUnlock = document.getElementById('btn-unlock');
const unlockError = document.getElementById('unlock-error');

const MAX_PASS_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30000;
let lockoutTimer = null;

function getFailedAttempts() {
  return parseInt(localStorage.getItem('cykel_failed_attempts') || '0', 10);
}
function setFailedAttempts(n) {
  localStorage.setItem('cykel_failed_attempts', String(n));
}
function getLockoutUntil() {
  return parseInt(localStorage.getItem('cykel_lockout_until') || '0', 10);
}
function setLockoutUntil(ts) {
  localStorage.setItem('cykel_lockout_until', String(ts));
}

function clearLockout() {
  localStorage.removeItem('cykel_failed_attempts');
  localStorage.removeItem('cykel_lockout_until');
  localStorage.removeItem('cykel_pin_fails');
  clearInterval(lockoutTimer);
  lockoutTimer = null;
}

function startLockoutCountdown() {
  const until = getLockoutUntil();
  if (!until || Date.now() >= until) {
    unlockError.textContent = '';
    btnUnlock.disabled = false;
    unlockPass.disabled = false;
    clearInterval(lockoutTimer);
    lockoutTimer = null;
    return;
  }

  btnUnlock.disabled = true;
  unlockPass.disabled = true;

  function tick() {
    const remaining = Math.max(0, Math.ceil((getLockoutUntil() - Date.now()) / 1000));
    if (remaining <= 0) {
      unlockError.textContent = '';
      btnUnlock.disabled = false;
      unlockPass.disabled = false;
      clearInterval(lockoutTimer);
      lockoutTimer = null;
    } else {
      unlockError.textContent = `Too many attempts. Try again in ${remaining}s`;
    }
  }
  tick();
  lockoutTimer = setInterval(tick, 1000);
}

if (getLockoutUntil() > Date.now()) {
  setTimeout(startLockoutCountdown, 0);
}

btnUnlock.addEventListener('click', async () => {
  if (getLockoutUntil() > Date.now()) {
    startLockoutCountdown();
    return;
  }

  const pass = unlockPass.value;
  unlockError.textContent = '';
  if (!pass) return;
  btnUnlock.disabled = true;

  try {
    const result = await storage.unlockWithPassphrase(pass);
    unlockPass.value = '';
    masterKeyBytes = result.masterKeyBytes;
    appData = result.data;
    clearLockout();

    if (!appData.settings) appData.settings = defaultAppData().settings;
    appData.cycles = rebuildCycles(appData.day_logs);
    await saveData();

    // Check if PIN is set, offer setup if not
    pinEnabled = await storage.hasPin();
    if (!pinEnabled) {
      showPinSetup();
    } else {
      enterApp();
    }
  } catch (e) {
    const attempts = getFailedAttempts() + 1;
    setFailedAttempts(attempts);

    if (attempts >= MAX_PASS_ATTEMPTS) {
      const multiplier = Math.pow(2, Math.floor(attempts / MAX_PASS_ATTEMPTS) - 1);
      setLockoutUntil(Date.now() + BASE_LOCKOUT_MS * multiplier);
      startLockoutCountdown();
    } else {
      const remaining = MAX_PASS_ATTEMPTS - attempts;
      unlockError.textContent = `Wrong passphrase. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`;
    }

    unlockPass.value = '';
    unlockPass.focus();
    const wrap = unlockPass.parentElement;
    wrap.classList.add('do-shake');
    setTimeout(() => wrap.classList.remove('do-shake'), 400);
  }
  if (!lockoutTimer) btnUnlock.disabled = false;
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
  document.getElementById('legend-fertile').classList.toggle('hidden', !showFertility);

  // Update PIN toggle in settings
  document.getElementById('toggle-pin').checked = pinEnabled;

  // Update bio toggle in settings (async, non-blocking)
  document.getElementById('toggle-bio').checked = bioEnabled;
  isBioSupported().then(supported => {
    document.getElementById('setting-bio-row').classList.toggle('hidden', !supported);
    if (supported && isIOS()) {
      document.getElementById('bio-label').textContent = 'Face ID / Touch ID';
    }
  });

  showScreen('calendar');
  renderCalendar();
  checkAlerts();
  resetAutoLock();
}

// ============================================
// Smart alerts & reminder prompt
// ============================================

function checkAlerts() {
  const banner = document.getElementById('alert-banner');
  const alertText = document.getElementById('alert-text');
  const reminderPrompt = document.getElementById('reminder-prompt');

  banner.classList.add('hidden');
  banner.classList.remove('alert-fertile');
  reminderPrompt.classList.add('hidden');

  if (!appData) return;

  const today = fmtDate(new Date());
  const pred = predict(appData.cycles);
  const fw = showFertility ? fertilityWindow(appData.cycles) : null;

  // Check for contextual alert (priority order)
  let alertMsg = null;
  let isFertileAlert = false;

  if (fw) {
    const daysToFertile = daysBetweenDates(today, fw.fertile_start);
    const daysToOvulation = daysBetweenDates(today, fw.ovulation_day);

    if (daysToOvulation === 0) {
      alertMsg = 'Estimated ovulation day';
      isFertileAlert = true;
    } else if (today >= fw.peak_start && today <= fw.peak_end && daysToOvulation !== 0) {
      alertMsg = 'Peak fertility — highest chance of conception';
      isFertileAlert = true;
    } else if (today >= fw.fertile_start && today <= fw.fertile_end) {
      alertMsg = 'You\'re in your fertile window';
      isFertileAlert = true;
    } else if (daysToFertile === 1) {
      alertMsg = 'Fertile window starts tomorrow';
      isFertileAlert = true;
    } else if (daysToFertile === 2) {
      alertMsg = 'Fertile window starts in 2 days';
      isFertileAlert = true;
    }
  }

  if (!alertMsg && pred) {
    const daysToPeriod = daysBetweenDates(today, pred.predicted_start);
    if (daysToPeriod === 0) {
      alertMsg = 'Period expected today';
    } else if (daysToPeriod === 1) {
      alertMsg = 'Period expected tomorrow';
    } else if (daysToPeriod === 2) {
      alertMsg = 'Period expected in 2 days';
    } else if (daysToPeriod === 3) {
      alertMsg = 'Period expected in 3 days';
    } else if (daysToPeriod < 0 && daysToPeriod >= -3) {
      // Period is late
      const late = Math.abs(daysToPeriod);
      alertMsg = `Period is ${late} day${late === 1 ? '' : 's'} late`;
    }
  }

  if (alertMsg) {
    alertText.textContent = alertMsg;
    if (isFertileAlert) banner.classList.add('alert-fertile');
    banner.classList.remove('hidden');
  }

  // Show reminder prompt once after first log
  if (appData.day_logs.length > 0 && !appData.settings.reminder_dismissed) {
    reminderPrompt.classList.remove('hidden');
  }
}

function daysBetweenDates(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

document.getElementById('btn-dismiss-alert').addEventListener('click', () => {
  document.getElementById('alert-banner').classList.add('hidden');
});

document.getElementById('btn-dismiss-reminder').addEventListener('click', async () => {
  document.getElementById('reminder-prompt').classList.add('hidden');
  if (appData) {
    appData.settings.reminder_dismissed = true;
    await saveData();
  }
});

// ============================================
// Auto-lock
// ============================================

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(doLock, autoLockMinutes * 60 * 1000);
}

document.addEventListener('pointerdown', resetAutoLock);
document.addEventListener('keydown', resetAutoLock);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && masterKeyBytes) {
    doLock();
  }
});

function doLock() {
  clearTimeout(autoLockTimer);
  zeroize(masterKeyBytes);
  masterKeyBytes = null;
  appData = null;
  bioTriedThisLock = false;

  if (pinEnabled) {
    resetPinDots('pin-unlock-dots');
    document.getElementById('pin-unlock-error').textContent = '';
    showScreen('pin-unlock');
  } else {
    showScreen('unlock');
  }
  showBioButtons();

  // Auto-trigger biometric on lock
  if (bioEnabled && !bioTriedThisLock) {
    bioTriedThisLock = true;
    setTimeout(() => attemptBioUnlock(), 300);
  }
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

  const logMap = {};
  appData.day_logs.forEach(l => { logMap[l.date] = l; });

  const symptomMap = {};
  appData.symptoms.forEach(s => {
    if (!symptomMap[s.date]) symptomMap[s.date] = [];
    symptomMap[s.date].push(s);
  });

  const pred = predict(appData.cycles);
  const predDates = new Set();
  if (pred) {
    let d = new Date(pred.predicted_start + 'T00:00:00');
    const end = new Date(pred.predicted_end + 'T00:00:00');
    while (d <= end) { predDates.add(fmtDate(d)); d.setDate(d.getDate() + 1); }
  }

  const fertileDates = new Set();
  const peakDates = new Set();
  let ovulationDate = null;
  const fw = showFertility ? fertilityWindow(appData.cycles) : null;

  if (fw) {
    let d = new Date(fw.fertile_start + 'T00:00:00');
    const end = new Date(fw.fertile_end + 'T00:00:00');
    while (d <= end) { fertileDates.add(fmtDate(d)); d.setDate(d.getDate() + 1); }
    let pk = new Date(fw.peak_start + 'T00:00:00');
    const pkEnd = new Date(fw.peak_end + 'T00:00:00');
    while (pk <= pkEnd) { peakDates.add(fmtDate(pk)); pk.setDate(pk.getDate() + 1); }
    ovulationDate = fw.ovulation_day;
  }

  const hasData = appData.day_logs.length > 0 || pred != null;
  emptyState.classList.toggle('hidden', hasData);
  cycleLegend.classList.toggle('hidden', !hasData);

  if (pred) {
    predictionCard.classList.remove('hidden');
    predictionText.textContent = fmtDatePretty(pred.predicted_start);
  } else {
    predictionCard.classList.add('hidden');
  }

  if (fw) {
    fertilityCard.classList.remove('hidden');
    fertilityText.textContent = `${fmtDateShort(fw.fertile_start)} - ${fmtDateShort(fw.fertile_end)}`;
  } else {
    fertilityCard.classList.add('hidden');
  }

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
    const hasFlow = log && log.flow_level !== 'None' && log.flow_level !== 'Spotting';
    const hasSpotting = log && log.flow_level === 'Spotting';
    if (hasFlow) cell.classList.add(`flow-${log.flow_level.toLowerCase()}`);
    if (hasSpotting) cell.classList.add('flow-spotting');

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

  const existing = appData.day_logs.find(l => l.date === selectedDate);
  if (existing) {
    existing.flow_level = selectedFlow;
    existing.notes = daylogNotes.value;
  } else {
    appData.day_logs.push({ date: selectedDate, flow_level: selectedFlow, notes: daylogNotes.value });
  }

  appData.symptoms = appData.symptoms.filter(s => s.date !== selectedDate);
  for (const sym of selectedSymptoms) {
    appData.symptoms.push({ date: selectedDate, symptom_type: sym, severity: 2 });
  }

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

  document.getElementById('stats-empty').classList.toggle('hidden', hasStats);
  document.getElementById('stats-content').classList.toggle('hidden', !hasStats);

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
  document.getElementById('legend-fertile').classList.toggle('hidden', !showFertility);
  if (appData) {
    appData.settings.show_fertility = showFertility;
    await saveData();
  }
});

// Bio toggle
document.getElementById('toggle-bio').addEventListener('change', async (e) => {
  if (e.target.checked) {
    try {
      const { credentialId, prfOutput } = await registerBioCredential();
      await storage.setupBio(masterKeyBytes, prfOutput, credentialId);
      bioEnabled = true;
    } catch {
      e.target.checked = false;
      showModal(
        'Not available',
        'Biometric authentication with encryption support is not available on this device. Use a PIN or passphrase instead.',
        'OK',
        () => {}
      );
    }
  } else {
    await storage.removeBio();
    bioEnabled = false;
  }
});

// PIN toggle
document.getElementById('toggle-pin').addEventListener('change', async (e) => {
  if (e.target.checked) {
    // Enable PIN — show setup
    showPinSetup();
  } else {
    // Disable PIN
    await storage.removePin();
    pinEnabled = false;
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
  showModal(
    'Export unencrypted?',
    'This creates a plaintext file anyone can read. Only save it somewhere private.',
    'Export Anyway',
    () => {
      const json = JSON.stringify(appData, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cykel-export-${fmtDate(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  );
});

// Wipe
document.getElementById('btn-wipe').addEventListener('click', () => {
  showModal(
    'Erase everything?',
    'All your cycle data will be permanently deleted. This cannot be undone.',
    'Erase All Data',
    async () => {
      await storage.wipe();
      zeroize(masterKeyBytes);
      masterKeyBytes = null;
      appData = null;
      pinEnabled = false;
      bioEnabled = false;
      clearLockout();
      showScreen('setup');
    },
    true
  );
});

// ============================================
// Modal
// ============================================

function showModal(title, message, confirmLabel, onConfirm, destructive = false) {
  const existing = document.getElementById('cykel-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'cykel-modal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3 class="modal-title">${title}</h3>
      <p class="modal-message">${message}</p>
      <div class="modal-actions">
        <button class="modal-btn modal-cancel">Cancel</button>
        <button class="modal-btn ${destructive ? 'modal-destructive' : 'modal-confirm'}">${confirmLabel}</button>
      </div>
    </div>`;

  document.getElementById('app').appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('modal-visible'));

  const close = () => {
    overlay.classList.remove('modal-visible');
    setTimeout(() => overlay.remove(), 200);
  };

  overlay.querySelector('.modal-cancel').addEventListener('click', close);
  overlay.querySelector('.modal-confirm, .modal-destructive').addEventListener('click', () => {
    close();
    onConfirm();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}

// ============================================
// Boot
// ============================================

init();
