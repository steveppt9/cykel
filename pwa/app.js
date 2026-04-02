// ============================================
// Cykel PWA — App v3 (PIN + passphrase + biometric unlock)
// ============================================

import * as storage from './storage.js';
import { zeroize } from './crypto.js';
import { rebuildCycles, predict, fertilityWindow, cycleStats, fmtDate } from './prediction.js';
import { pandaKB, DISCLAIMER } from './panda-kb.js';

// ============================================
// Haptic feedback
// ============================================

function haptic(style = 'light') {
  if (!navigator.vibrate) return;
  if (style === 'light') navigator.vibrate(8);
  else if (style === 'medium') navigator.vibrate(15);
  else if (style === 'success') navigator.vibrate([10, 40, 10]);
  else if (style === 'error') navigator.vibrate([30, 50, 30]);
}

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
let appMode = 'tracking'; // 'tracking', 'ttc', 'pregnancy'
let selectedMoods = new Set();
let selectedDischarge = null;
let selectedDischargeColor = null;
let selectedSex = null;
let selectedSexDrive = null;
let selectedEnergy = null;
let selectedSleep = null;
let selectedExercise = null;
let selectedCrampLevel = 0;

// Weekly pregnancy milestones — fruit size comparison + development facts
const PREGNANCY_WEEKS = {
  0:  { emoji: '🌱', name: 'Just beginning', size: 'Tiny cluster of cells', fact: 'Fertilization just happened — a single cell is dividing rapidly into what will become your baby.' },
  1:  { emoji: '🌱', name: 'Just beginning', size: 'Tiny cluster of cells', fact: 'Your body is preparing the uterine lining for implantation.' },
  2:  { emoji: '🌱', name: 'Just beginning', size: 'Tiny cluster of cells', fact: 'Ovulation and conception typically happen around now.' },
  3:  { emoji: '🌱', name: 'Implantation', size: 'Smaller than a grain of sand', fact: 'The fertilized egg is burrowing into your uterine lining. You might notice light spotting.' },
  4:  { emoji: '🌰', name: 'Poppy seed', size: '~1mm', fact: 'A positive test is possible now. The embryo is forming its neural tube, which becomes the brain and spine.' },
  5:  { emoji: '🫘', name: 'Sesame seed', size: '~2mm', fact: 'The heart is forming and will start beating this week. Tiny buds are appearing where arms and legs will grow.' },
  6:  { emoji: '🫐', name: 'Blueberry', size: '~6mm', fact: 'The heart is beating about 110 times per minute. Facial features are starting to form — little dots for eyes and nostrils.' },
  7:  { emoji: '🫐', name: 'Raspberry', size: '~1.3cm', fact: 'Hands and feet are forming with tiny webbed fingers. The brain is growing rapidly — about 100 new brain cells every minute.' },
  8:  { emoji: '🫒', name: 'Olive', size: '~1.6cm', fact: 'Baby is officially called a fetus now. Fingers and toes are separating and tiny eyelids are forming.' },
  9:  { emoji: '🍇', name: 'Grape', size: '~2.3cm', fact: 'All major organs are in place. Baby is starting to make tiny movements — too small for you to feel yet.' },
  10: { emoji: '🍓', name: 'Strawberry', size: '~3cm', fact: 'Fingernails and toenails are starting to develop. Baby can now bend their tiny limbs.' },
  11: { emoji: '🫐', name: 'Fig', size: '~4cm', fact: 'Baby\'s bones are starting to harden and tooth buds are forming under the gums.' },
  12: { emoji: '🍋', name: 'Lime', size: '~5.4cm', fact: 'End of the first trimester! Baby\'s reflexes are developing — they can open and close their fists.' },
  13: { emoji: '🍋', name: 'Lemon', size: '~7.4cm', fact: 'Welcome to the second trimester. Baby has fingerprints now and vocal cords are forming.' },
  14: { emoji: '🍑', name: 'Peach', size: '~8.7cm', fact: 'Baby is making facial expressions — squinting, frowning, grimacing. They\'re practicing for all those cute faces.' },
  15: { emoji: '🍎', name: 'Apple', size: '~10cm', fact: 'Baby can sense light through the eyelids and is developing a fine layer of hair called lanugo.' },
  16: { emoji: '🥑', name: 'Avocado', size: '~11.6cm', fact: 'Baby can hear sounds now — your heartbeat, your voice, your stomach growling. They\'re listening.' },
  17: { emoji: '🍐', name: 'Pear', size: '~13cm', fact: 'Fat is starting to form under baby\'s skin. The umbilical cord is getting thicker and stronger.' },
  18: { emoji: '🫑', name: 'Bell pepper', size: '~14.2cm', fact: 'If you haven\'t felt movement yet, you might this week — little flutters called "quickening."' },
  19: { emoji: '🥭', name: 'Mango', size: '~15.3cm', fact: 'A waxy coating called vernix is forming to protect baby\'s skin in the amniotic fluid.' },
  20: { emoji: '🍌', name: 'Banana', size: '~25cm head to toe', fact: 'Halfway there! Baby can swallow and is gulping amniotic fluid. Anatomy scan week — you might learn the sex.' },
  21: { emoji: '🥕', name: 'Carrot', size: '~27cm', fact: 'Baby\'s taste buds are working — they can taste what you eat through the amniotic fluid.' },
  22: { emoji: '🌽', name: 'Corn on the cob', size: '~28cm', fact: 'Eyebrows and eyelashes are now visible. Baby looks more and more like a tiny human.' },
  23: { emoji: '🥝', name: 'Grapefruit', size: '~29cm', fact: 'Baby can hear outside noises now. Play them some music — they might respond with a kick.' },
  24: { emoji: '🌶️', name: 'Ear of corn', size: '~30cm', fact: 'Lungs are developing tiny air sacs. Baby has a regular sleep-wake cycle (probably opposite yours).' },
  25: { emoji: '🥦', name: 'Cauliflower', size: '~35cm', fact: 'Baby is gaining about 6 oz per week now. They can respond to your voice and familiar sounds.' },
  26: { emoji: '🥬', name: 'Lettuce head', size: '~36cm', fact: 'Eyes are opening for the first time. Baby can now see light filtering through your belly.' },
  27: { emoji: '🥒', name: 'Cucumber', size: '~37cm', fact: 'Baby is inhaling and exhaling amniotic fluid — practice breathing. The brain is very active now.' },
  28: { emoji: '🍆', name: 'Eggplant', size: '~38cm', fact: 'Welcome to the third trimester! Baby can blink, dream during REM sleep, and has their own immune system starting up.' },
  29: { emoji: '🎃', name: 'Acorn squash', size: '~39cm', fact: 'Baby is getting stronger — kicks might actually make you jump. Muscles and lungs continue maturing.' },
  30: { emoji: '🥥', name: 'Coconut', size: '~40cm', fact: 'Baby\'s brain is developing rapidly with billions of neurons. They can now regulate their own body temperature somewhat.' },
  31: { emoji: '🥥', name: 'Coconut', size: '~41cm', fact: 'Baby is processing information from all five senses. They can turn their head to follow a light source.' },
  32: { emoji: '🍈', name: 'Squash', size: '~42cm', fact: 'Toenails have arrived. Baby is practicing breathing, grasping, and sucking — getting ready for the outside world.' },
  33: { emoji: '🍍', name: 'Pineapple', size: '~44cm', fact: 'Baby\'s bones are hardening but the skull stays flexible for delivery. They\'re running out of room in there.' },
  34: { emoji: '🍍', name: 'Pineapple', size: '~45cm', fact: 'Baby\'s central nervous system and lungs are maturing. Fat layers are filling out those adorable chubby cheeks.' },
  35: { emoji: '🍈', name: 'Honeydew', size: '~46cm', fact: 'Most babies are head-down by now, getting into position. Kidneys are fully developed.' },
  36: { emoji: '🥬', name: 'Romaine lettuce', size: '~47cm', fact: 'Baby is shedding most of the lanugo hair and vernix coating. You might notice them hiccuping.' },
  37: { emoji: '🥬', name: 'Swiss chard', size: '~48cm', fact: 'Baby is now considered "early term." They\'re practicing breathing and can firmly grasp a finger.' },
  38: { emoji: '🍉', name: 'Mini watermelon', size: '~50cm', fact: 'Baby\'s organs are ready for life outside. They\'re producing surfactant to help lungs expand after birth.' },
  39: { emoji: '🍉', name: 'Watermelon', size: '~51cm', fact: 'Baby\'s brain and lungs are still maturing right up to delivery. The average baby is about 7-8 lbs now.' },
  40: { emoji: '🍉', name: 'Watermelon', size: '~51cm, ~7.5 lbs', fact: 'Due date week! Baby is fully developed and ready to meet you. Only 5% of babies arrive on their exact due date — yours will come when they\'re ready.' },
  41: { emoji: '🍉', name: 'Watermelon+', size: '~52cm', fact: 'A little past due — totally normal. Your doctor will monitor closely. Baby is still growing and gaining about half an ounce per day.' },
  42: { emoji: '🍉', name: 'Watermelon+', size: '~52cm', fact: 'Your doctor will likely discuss induction options. Baby is fully cooked — just taking their sweet time.' }
};

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
    haptic('error');
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
    haptic();

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

  appMode = appData.settings.mode || 'tracking';
  updateModeSelector();
  renderBirthControl();
  renderColorCustomizer();
  applyCustomColors();

  showScreen('calendar');
  renderCalendar();
  checkAlerts();
  resetAutoLock();

  // Show panda hint bubble after a short delay
  setTimeout(showPandaHint, 3000);
}

// ============================================
// Mode selector
// ============================================

function updateModeSelector() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === appMode);
  });
}

document.getElementById('mode-selector').addEventListener('click', async (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;

  const newMode = btn.dataset.mode;

  if (newMode === 'pregnancy' && !appData.settings.due_date) {
    promptDueDate();
    return;
  }

  appMode = newMode;
  appData.settings.mode = appMode;

  // Auto-enable fertility window in TTC mode
  if (appMode === 'ttc') {
    showFertility = true;
    appData.settings.show_fertility = true;
    document.getElementById('toggle-fertility').checked = true;
    document.getElementById('legend-fertile').classList.remove('hidden');
  }

  await saveData();
  updateModeSelector();
  showScreen('calendar');
  renderCalendar();
});

function promptDueDate() {
  const lastCycle = appData.cycles.filter(c => c.end_date).sort((a, b) => b.start_date.localeCompare(a.start_date))[0];

  if (lastCycle) {
    const lmpDate = new Date(lastCycle.start_date + 'T00:00:00');
    const dueDate = new Date(lmpDate);
    dueDate.setDate(dueDate.getDate() + 280);
    const dueDateStr = fmtDate(dueDate);

    showModal(
      'Start Pregnancy Mode?',
      `Based on your last period (${fmtDatePretty(lastCycle.start_date)}), your estimated due date is ${fmtDatePretty(dueDateStr)}. You can change this in settings later.`,
      'Start',
      async () => {
        appData.settings.due_date = dueDateStr;
        appData.settings.mode = 'pregnancy';
        appMode = 'pregnancy';
        await saveData();
        updateModeSelector();
        showScreen('calendar');
        renderCalendar();
      }
    );
  } else {
    showModal(
      'No cycle data',
      'Log at least one complete cycle before switching to pregnancy mode, so we can calculate your due date.',
      'OK',
      () => {}
    );
  }
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
  banner.classList.remove('alert-doctor');
  banner.removeAttribute('data-doctor-alert-id');
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

  // Doctor alerts (lower priority — only show if no fertility/period alert)
  if (!alertMsg) {
    appData.settings.dismissed_alerts = appData.settings.dismissed_alerts || {};
    const dismissed = appData.settings.dismissed_alerts;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = fmtDate(thirtyDaysAgo);

    function isDismissed(alertId) {
      return dismissed[alertId] && dismissed[alertId] >= thirtyDaysAgoStr;
    }

    let doctorAlertId = null;
    let doctorMsg = null;

    // Rule 1: Irregular cycles (2+ completed cycles <21 or >35 days)
    if (!doctorMsg) {
      const completed = appData.cycles.filter(c => c.end_date != null).sort((a, b) => a.start_date.localeCompare(b.start_date));
      let irregularCount = 0;
      for (let i = 1; i < completed.length; i++) {
        const len = daysBetweenDates(completed[i - 1].start_date, completed[i].start_date);
        if (len < 21 || len > 35) irregularCount++;
      }
      if (irregularCount >= 2 && !isDismissed('irregular_cycles')) {
        doctorAlertId = 'irregular_cycles';
        doctorMsg = 'Your cycles seem irregular \u2014 a doctor can help find out why';
      }
    }

    // Rule 2: Long period (>7 days in last 3 months)
    if (!doctorMsg) {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const threeMonthsAgoStr = fmtDate(threeMonthsAgo);
      const recentCycles = appData.cycles.filter(c => c.end_date && c.start_date >= threeMonthsAgoStr);
      const longPeriod = recentCycles.some(c => {
        const periodLen = daysBetweenDates(c.start_date, c.end_date) + 1;
        return periodLen > 7;
      });
      if (longPeriod && !isDismissed('long_period')) {
        doctorAlertId = 'long_period';
        doctorMsg = 'Your last period was longer than usual \u2014 worth mentioning to your doctor';
      }
    }

    // Rule 3: Green/yellow discharge today or yesterday
    if (!doctorMsg) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = fmtDate(yesterday);
      const recentLogs = appData.day_logs.filter(l => l.date === today || l.date === yesterdayStr);
      const unusualColor = recentLogs.some(l => l.discharge_color === 'Green' || l.discharge_color === 'Yellow');
      if (unusualColor && !isDismissed('unusual_discharge')) {
        doctorAlertId = 'unusual_discharge';
        doctorMsg = 'Unusual discharge color \u2014 consider seeing your doctor';
      }
    }

    // Rule 4: Late period >7 days
    if (!doctorMsg && pred) {
      const daysToPeriod = daysBetweenDates(today, pred.predicted_start);
      if (daysToPeriod < -7 && !isDismissed('late_period_doctor')) {
        doctorAlertId = 'late_period_doctor';
        doctorMsg = 'Your period is over a week late \u2014 consider a pregnancy test or check with your doctor';
      }
    }

    // Rule 5: Persistent nausea + late period
    if (!doctorMsg && pred) {
      const daysToPeriod = daysBetweenDates(today, pred.predicted_start);
      if (daysToPeriod < 0) {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        const oneWeekAgoStr = fmtDate(oneWeekAgo);
        const recentSymptoms = appData.symptoms.filter(s => s.date >= oneWeekAgoStr && s.date <= today && s.symptom_type === 'Nausea');
        const nauseaDays = new Set(recentSymptoms.map(s => s.date)).size;
        if (nauseaDays >= 3 && !isDismissed('nausea_late')) {
          doctorAlertId = 'nausea_late';
          doctorMsg = 'Nausea with a late period \u2014 you may want to take a pregnancy test';
        }
      }
    }

    if (doctorMsg) {
      alertMsg = doctorMsg;
      banner.setAttribute('data-doctor-alert-id', doctorAlertId);
      banner.classList.add('alert-doctor');
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

function renderPhaseCard() {
  const card = document.getElementById('phase-card');
  card.classList.add('hidden');
  card.className = 'phase-card hidden';

  if (!appData || appData.cycles.length === 0) return;
  if (appMode === 'pregnancy') return;

  const today = fmtDate(new Date());
  const completed = appData.cycles
    .filter(c => c.end_date != null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (completed.length < 1) return;

  // Find the most recent cycle start
  const lastCycle = completed[completed.length - 1];
  const cycleDay = daysBetweenDates(lastCycle.start_date, today) + 1;

  if (cycleDay < 1 || cycleDay > 60) return;

  // Determine average cycle length and period length
  const stats = cycleStats(appData.cycles);
  const avgCycle = stats.avg_cycle_length || 28;
  const avgPeriod = stats.avg_period_length || 5;
  const ovulationDay = Math.round(avgCycle - 14);

  let phaseName, phaseTip, phaseClass;

  if (cycleDay <= avgPeriod) {
    // Menstrual phase
    phaseName = 'Period';
    phaseClass = 'phase-period';
    if (cycleDay <= 2) phaseTip = 'Rest up — your body is doing its thing';
    else phaseTip = 'Energy may start coming back soon';
  } else if (cycleDay <= ovulationDay - 3) {
    // Follicular phase
    phaseName = 'Follicular Phase';
    phaseClass = 'phase-follicular';
    phaseTip = 'Energy and mood tend to rise — good time to start new things';
  } else if (cycleDay <= ovulationDay + 1) {
    // Ovulation phase
    phaseName = 'Ovulation Phase';
    phaseClass = 'phase-ovulation';
    phaseTip = 'Peak energy and confidence — most fertile days';
  } else {
    // Luteal phase
    phaseName = 'Luteal Phase';
    phaseClass = 'phase-luteal';
    const daysLeft = Math.max(0, Math.round(avgCycle) - cycleDay);
    if (daysLeft <= 3) phaseTip = 'Period may start soon — be kind to yourself';
    else if (daysLeft <= 7) phaseTip = 'PMS symptoms might show up — totally normal';
    else phaseTip = 'Progesterone is up — you might crave comfort and rest';
  }

  document.getElementById('phase-day-num').textContent = cycleDay;
  document.getElementById('phase-name').textContent = `Day ${cycleDay} · ${phaseName}`;
  document.getElementById('phase-tip').textContent = phaseTip;
  card.className = `phase-card ${phaseClass}`;
}

function daysBetweenDates(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

async function dismissAlert() {
  const banner = document.getElementById('alert-banner');
  const doctorAlertId = banner.getAttribute('data-doctor-alert-id');
  if (doctorAlertId && appData) {
    appData.settings.dismissed_alerts = appData.settings.dismissed_alerts || {};
    appData.settings.dismissed_alerts[doctorAlertId] = fmtDate(new Date());
    await saveData();
  }
  banner.classList.add('alert-dismiss-anim');
  setTimeout(() => {
    banner.classList.add('hidden');
    banner.classList.remove('alert-dismiss-anim');
    banner.style.transform = '';
    banner.style.opacity = '';
  }, 250);
}

document.getElementById('btn-dismiss-alert').addEventListener('click', dismissAlert);

// Swipe-to-dismiss on alert banner
(function() {
  const banner = document.getElementById('alert-banner');
  let startX = 0, currentX = 0, swiping = false;

  banner.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    currentX = startX;
    swiping = true;
  }, { passive: true });

  banner.addEventListener('touchmove', e => {
    if (!swiping) return;
    currentX = e.touches[0].clientX;
    const dx = currentX - startX;
    if (Math.abs(dx) > 10) {
      banner.style.transform = `translateX(${dx}px)`;
      banner.style.opacity = `${1 - Math.abs(dx) / 300}`;
    }
  }, { passive: true });

  banner.addEventListener('touchend', () => {
    if (!swiping) return;
    swiping = false;
    const dx = currentX - startX;
    if (Math.abs(dx) > 80) {
      dismissAlert();
    } else {
      banner.style.transform = '';
      banner.style.opacity = '';
    }
  });
})();

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

  renderPhaseCard();
  renderPandaChips();

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

  // Mode-specific cards
  const pregnancyCard = document.getElementById('pregnancy-card');
  const ttcCard = document.getElementById('ttc-card');

  pregnancyCard.classList.add('hidden');
  ttcCard.classList.add('hidden');

  if (appMode === 'pregnancy' && appData.settings.due_date) {
    const dueDate = appData.settings.due_date;
    const today = fmtDate(new Date());
    const lmpDate = new Date(dueDate + 'T00:00:00');
    lmpDate.setDate(lmpDate.getDate() - 280);
    const daysPregnant = daysBetweenDates(fmtDate(lmpDate), today);
    const weeksPregnant = Math.floor(daysPregnant / 7);
    const daysExtra = daysPregnant % 7;

    if (weeksPregnant >= 0 && weeksPregnant <= 42) {
      const milestone = PREGNANCY_WEEKS[Math.min(weeksPregnant, 42)] || PREGNANCY_WEEKS[42];

      document.getElementById('preg-week-num').textContent = weeksPregnant;
      document.getElementById('preg-fruit').textContent = milestone.emoji;
      document.getElementById('preg-status').textContent = milestone.name;
      document.getElementById('preg-size-label').textContent = milestone.size;
      document.getElementById('preg-fact').textContent = milestone.fact;

      const daysLeft = daysBetweenDates(today, dueDate);
      const progressPct = Math.min(100, Math.max(0, Math.round((daysPregnant / 280) * 100)));
      document.getElementById('preg-due').textContent = daysLeft > 0
        ? `${daysLeft} days until due date · ${fmtDatePretty(dueDate)}`
        : daysLeft === 0 ? `Due today!` : `${Math.abs(daysLeft)} days past due date`;
      document.getElementById('preg-progress-fill').style.width = progressPct + '%';

      pregnancyCard.classList.remove('hidden');
    }

    // Hide period-specific cards in pregnancy mode
    predictionCard.classList.add('hidden');
    fertilityCard.classList.add('hidden');
    emptyState.classList.add('hidden');
  }

  if (appMode === 'ttc') {
    const ttcTipText = document.getElementById('ttc-tip-text');

    if (fw) {
      const today = fmtDate(new Date());
      const daysToFertile = daysBetweenDates(today, fw.fertile_start);
      const daysToOvulation = daysBetweenDates(today, fw.ovulation_day);

      if (daysToOvulation === 0) {
        ttcTipText.textContent = 'Ovulation day — best chance of conception';
      } else if (today >= fw.peak_start && today <= fw.peak_end) {
        ttcTipText.textContent = 'Peak fertility — have sex today and tomorrow';
      } else if (today >= fw.fertile_start && today <= fw.fertile_end) {
        ttcTipText.textContent = 'Fertile — have sex every 1-2 days';
      } else if (daysToFertile > 0 && daysToFertile <= 5) {
        ttcTipText.textContent = `Fertile window in ${daysToFertile} days — stay healthy and hydrated`;
      } else {
        ttcTipText.textContent = 'Keep logging to improve predictions';
      }
      ttcCard.classList.remove('hidden');
    }

    // Auto-enable fertility in TTC mode
    if (!showFertility) {
      showFertility = true;
      document.getElementById('toggle-fertility').checked = true;
      document.getElementById('legend-fertile').classList.remove('hidden');
    }
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

    // Indicator dots
    const dots = [];
    if (hasFlow || hasSpotting) dots.push('day-dot-flow');
    if (symptomMap[dateStr]) dots.push('day-dot-symptom');
    if (log && log.moods && log.moods.length) dots.push('day-dot-mood');
    if (log && log.sex && log.sex !== 'None') dots.push('day-dot-sex');
    if (dots.length) {
      const dotWrap = document.createElement('div');
      dotWrap.className = 'day-dots';
      dots.forEach(cls => {
        const dot = document.createElement('div');
        dot.className = `day-dot ${cls}`;
        dotWrap.appendChild(dot);
      });
      cell.appendChild(dotWrap);
    }

    cell.addEventListener('click', () => { haptic(); openDayLog(dateStr, log, symptomMap[dateStr]); });
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

  // New fields
  selectedMoods = new Set(existingLog?.moods || []);
  selectedDischarge = existingLog?.discharge || null;
  selectedDischargeColor = existingLog?.discharge_color || null;
  selectedSex = existingLog?.sex || null;
  selectedSexDrive = existingLog?.sex_drive || null;
  selectedEnergy = existingLog?.energy || null;
  selectedSleep = existingLog?.sleep || null;
  selectedExercise = existingLog?.exercise || null;
  daylogNotes.value = existingLog ? (existingLog.notes || '') : '';

  // Load cramp severity
  const crampEntry = existingSymptoms ? existingSymptoms.find(s => s.symptom_type === 'Cramps') : null;
  selectedCrampLevel = crampEntry ? (crampEntry.severity || 5) : 5;

  updateFlowButtons();
  updateMoodChips();
  updateSymptomChips();
  updateCrampScale();

  updateSelectRow('discharge-buttons', selectedDischarge);
  updateSelectRow('discharge-color-buttons', selectedDischargeColor);
  updateSelectRow('sex-buttons', selectedSex);
  updateSexDriveVisibility();
  updatePillRow('drive-buttons', selectedSexDrive);
  updatePillRow('energy-buttons', selectedEnergy);
  updatePillRow('sleep-buttons', selectedSleep);
  updatePillRow('exercise-buttons', selectedExercise);
  showScreen('daylog');
}

function updateFlowButtons() {
  document.querySelectorAll('.flow-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.flow === selectedFlow);
  });
}

function updateMoodChips() {
  document.querySelectorAll('#mood-chips .mood-pill').forEach(chip => {
    chip.classList.toggle('active', selectedMoods.has(chip.dataset.mood));
  });
}

function updateSymptomChips() {
  document.querySelectorAll('#symptom-chips .chip').forEach(chip => {
    chip.classList.toggle('active', selectedSymptoms.has(chip.dataset.symptom));
  });
}

function updateSelectRow(id, value) {
  document.querySelectorAll(`#${id} .select-opt`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === value);
  });
}

function updatePillRow(id, value) {
  document.querySelectorAll(`#${id} .pill-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === value);
  });
}

function updateSexDriveVisibility() {
  const driveRow = document.getElementById('sex-drive-row');
  driveRow.classList.toggle('hidden', !selectedSex || selectedSex === 'None');
}

document.getElementById('flow-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.flow-opt');
  if (!btn) return;
  haptic();
  selectedFlow = btn.dataset.flow;
  updateFlowButtons();
});

// Mood chips (multi-select)
document.getElementById('mood-chips').addEventListener('click', e => {
  const chip = e.target.closest('.mood-pill');
  if (!chip) return;
  haptic();
  const mood = chip.dataset.mood;
  if (selectedMoods.has(mood)) selectedMoods.delete(mood);
  else selectedMoods.add(mood);
  updateMoodChips();
});

function updateCrampScale() {
  const scaleEl = document.getElementById('cramp-scale');
  const slider = document.getElementById('cramp-slider');
  const valueEl = document.getElementById('cramp-value');
  if (selectedSymptoms.has('Cramps')) {
    scaleEl.classList.remove('hidden');
    slider.value = selectedCrampLevel || 5;
    valueEl.textContent = slider.value;
  } else {
    scaleEl.classList.add('hidden');
  }
}

document.getElementById('cramp-slider').addEventListener('input', (e) => {
  selectedCrampLevel = parseInt(e.target.value);
  document.getElementById('cramp-value').textContent = selectedCrampLevel;
});

document.getElementById('symptom-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  haptic();
  const sym = chip.dataset.symptom;
  if (selectedSymptoms.has(sym)) selectedSymptoms.delete(sym);
  else selectedSymptoms.add(sym);
  updateSymptomChips();
  updateCrampScale();
});

// Discharge (single-select)
document.getElementById('discharge-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.select-opt');
  if (!btn) return;
  selectedDischarge = btn.dataset.val === selectedDischarge ? null : btn.dataset.val;
  updateSelectRow('discharge-buttons', selectedDischarge);
});

// Discharge color (single-select)
document.getElementById('discharge-color-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.select-opt');
  if (!btn) return;
  selectedDischargeColor = btn.dataset.val === selectedDischargeColor ? null : btn.dataset.val;
  updateSelectRow('discharge-color-buttons', selectedDischargeColor);
});

// Sex (single-select)
document.getElementById('sex-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.select-opt');
  if (!btn) return;
  selectedSex = btn.dataset.val === selectedSex ? null : btn.dataset.val;
  if (!selectedSex || selectedSex === 'None') selectedSexDrive = null;
  updateSelectRow('sex-buttons', selectedSex);
  updateSexDriveVisibility();
  updatePillRow('drive-buttons', selectedSexDrive);
});

// Sex drive (single-select)
document.getElementById('drive-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  selectedSexDrive = btn.dataset.val === selectedSexDrive ? null : btn.dataset.val;
  updatePillRow('drive-buttons', selectedSexDrive);
});

// Energy (single-select)
document.getElementById('energy-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  selectedEnergy = btn.dataset.val === selectedEnergy ? null : btn.dataset.val;
  updatePillRow('energy-buttons', selectedEnergy);
});

// Sleep (single-select)
document.getElementById('sleep-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  selectedSleep = btn.dataset.val === selectedSleep ? null : btn.dataset.val;
  updatePillRow('sleep-buttons', selectedSleep);
});

// Exercise (single-select)
document.getElementById('exercise-buttons').addEventListener('click', e => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  selectedExercise = btn.dataset.val === selectedExercise ? null : btn.dataset.val;
  updatePillRow('exercise-buttons', selectedExercise);
});

document.getElementById('btn-save-day').addEventListener('click', async () => {
  if (!selectedDate || !appData) return;
  haptic('success');

  const logData = {
    date: selectedDate,
    flow_level: selectedFlow,
    moods: [...selectedMoods],
    discharge: selectedDischarge,
    discharge_color: selectedDischargeColor,
    sex: selectedSex,
    sex_drive: selectedSexDrive,
    energy: selectedEnergy,
    sleep: selectedSleep,
    exercise: selectedExercise,
    notes: daylogNotes.value,
  };

  const idx = appData.day_logs.findIndex(l => l.date === selectedDate);
  if (idx >= 0) {
    appData.day_logs[idx] = logData;
  } else {
    appData.day_logs.push(logData);
  }

  appData.symptoms = appData.symptoms.filter(s => s.date !== selectedDate);
  for (const sym of selectedSymptoms) {
    const severity = sym === 'Cramps' ? selectedCrampLevel : 2;
    appData.symptoms.push({ date: selectedDate, symptom_type: sym, severity });
  }

  appData.cycles = rebuildCycles(appData.day_logs);
  await saveData();
  showScreen('calendar');
  renderCalendar();
});

document.getElementById('btn-back').addEventListener('click', () => showScreen('calendar'));

// Clear day
document.getElementById('btn-clear-day').addEventListener('click', async () => {
  if (!selectedDate || !appData) return;
  haptic('light');

  // Remove day log
  appData.day_logs = appData.day_logs.filter(l => l.date !== selectedDate);
  // Remove symptoms
  appData.symptoms = appData.symptoms.filter(s => s.date !== selectedDate);
  // Rebuild cycles
  appData.cycles = rebuildCycles(appData.day_logs);
  await saveData();

  // Reset UI to blank state
  selectedFlow = 'None';
  selectedSymptoms = new Set();
  selectedMoods = new Set();
  selectedDischarge = null;
  selectedDischargeColor = null;
  selectedSex = null;
  selectedSexDrive = null;
  selectedEnergy = null;
  selectedSleep = null;
  selectedExercise = null;
  selectedCrampLevel = 0;
  daylogNotes.value = '';

  updateFlowButtons();
  updateMoodChips();
  updateSymptomChips();
  updateCrampScale();
  updateSelectRow('discharge-buttons', null);
  updateSelectRow('discharge-color-buttons', null);
  updateSelectRow('sex-buttons', null);
  updateSexDriveVisibility();
  updatePillRow('drive-buttons', null);
  updatePillRow('energy-buttons', null);
  updatePillRow('sleep-buttons', null);
  updatePillRow('exercise-buttons', null);
});

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

  if (!hasStats) return;

  // Basic stats
  document.getElementById('stat-avg-cycle').textContent = `${Math.round(stats.avg_cycle_length)}d`;
  document.getElementById('stat-avg-period').textContent = `${Math.round(stats.avg_period_length)}d`;
  document.getElementById('stat-shortest').textContent = stats.shortest_cycle != null ? `${stats.shortest_cycle}d` : '--';
  document.getElementById('stat-longest').textContent = stats.longest_cycle != null ? `${stats.longest_cycle}d` : '--';
  document.getElementById('stat-total').textContent = stats.total_cycles;
  document.getElementById('stat-last-start').textContent = stats.last_period_start ? fmtDatePretty(stats.last_period_start) : '--';
  document.getElementById('stat-last-end').textContent = stats.last_period_end ? fmtDatePretty(stats.last_period_end) : '--';

  // Cycle length chart
  renderCycleChart();

  // Symptom patterns
  renderSymptomSummary();

  // Mood patterns
  renderMoodSummary();
});

function renderCycleChart() {
  const container = document.getElementById('chart-bars');
  container.innerHTML = '';

  const completed = appData.cycles
    .filter(c => c.end_date != null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (completed.length < 2) {
    document.getElementById('cycle-chart').classList.add('hidden');
    return;
  }

  document.getElementById('cycle-chart').classList.remove('hidden');

  const recent = completed.slice(-7); // need 7 cycles to get 6 lengths
  const lengths = [];
  for (let i = 1; i < recent.length; i++) {
    const len = daysBetweenDates(recent[i - 1].start_date, recent[i].start_date);
    const month = new Date(recent[i].start_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' });
    lengths.push({ len, month });
  }

  const maxLen = Math.max(...lengths.map(l => l.len));

  lengths.forEach(({ len, month }) => {
    const wrap = document.createElement('div');
    wrap.className = 'chart-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'chart-bar';
    bar.style.height = `${(len / maxLen) * 100}%`;
    const label = document.createElement('span');
    label.className = 'chart-bar-label';
    label.textContent = `${len}`;
    const sub = document.createElement('span');
    sub.className = 'chart-bar-sub';
    sub.textContent = month;
    wrap.appendChild(bar);
    wrap.appendChild(label);
    wrap.appendChild(sub);
    container.appendChild(wrap);
  });
}

const SYMPTOM_NAME_MAP = {
  Cramps: 'Cramps', Headache: 'Headache', Backache: 'Backache',
  Bloating: 'Bloating', Nausea: 'Nausea',
  Fatigue: 'Fatigue', Acne: 'Acne', HotFlashes: 'Hot Flashes',
  Dizziness: 'Dizziness', JointPain: 'Joint Pain', Insomnia: 'Insomnia',
  BreastPain: 'Breast Pain', PelvicPressure: 'Pelvic Pressure',
  Cravings: 'Cravings', Diarrhea: 'Diarrhea', Constipation: 'Constipation',
  AppetiteChanges: 'Appetite Changes',
  HeavyDischarge: 'Heavy Discharge', LightDischarge: 'Light Discharge'
};

function renderSymptomSummary() {
  const container = document.getElementById('symptom-bars');
  container.innerHTML = '';

  const counts = {};
  appData.symptoms.forEach(s => {
    counts[s.symptom_type] = (counts[s.symptom_type] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (!sorted.length) {
    document.getElementById('symptom-summary').classList.add('hidden');
    return;
  }
  document.getElementById('symptom-summary').classList.remove('hidden');

  const maxCount = sorted[0][1];
  sorted.forEach(([type, count]) => {
    const row = document.createElement('div');
    row.className = 'pattern-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'pattern-label';
    labelEl.textContent = SYMPTOM_NAME_MAP[type] || type;

    const track = document.createElement('div');
    track.className = 'pattern-track';
    const fill = document.createElement('div');
    fill.className = 'pattern-fill';
    fill.style.width = `${(count / maxCount) * 100}%`;
    track.appendChild(fill);

    const countEl = document.createElement('span');
    countEl.className = 'pattern-count';
    countEl.textContent = count;

    row.appendChild(labelEl);
    row.appendChild(track);
    row.appendChild(countEl);
    container.appendChild(row);
  });
}

function renderMoodSummary() {
  const container = document.getElementById('mood-bars');
  container.innerHTML = '';

  const counts = {};
  appData.day_logs.forEach(log => {
    if (log.moods) {
      log.moods.forEach(m => {
        counts[m] = (counts[m] || 0) + 1;
      });
    }
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  if (!sorted.length) {
    document.getElementById('mood-summary').classList.add('hidden');
    return;
  }
  document.getElementById('mood-summary').classList.remove('hidden');

  const maxCount = sorted[0][1];
  sorted.forEach(([mood, count]) => {
    const row = document.createElement('div');
    row.className = 'pattern-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'pattern-label';
    labelEl.textContent = mood;

    const track = document.createElement('div');
    track.className = 'pattern-track';
    const fill = document.createElement('div');
    fill.className = 'pattern-fill mood-fill';
    fill.style.width = `${(count / maxCount) * 100}%`;
    track.appendChild(fill);

    const countEl = document.createElement('span');
    countEl.className = 'pattern-count';
    countEl.textContent = count;

    row.appendChild(labelEl);
    row.appendChild(track);
    row.appendChild(countEl);
    container.appendChild(row);
  });
}

// Build printable HTML for doctor report (used by print & share)
function buildReportPrintHTML(stats, completed, topSymptoms, topMoods, reportNameMap, sixMonthsAgo, now) {
  const avgCycle = stats.avg_cycle_length ? Math.round(stats.avg_cycle_length) + 'd' : '--';
  const avgPeriod = stats.avg_period_length ? Math.round(stats.avg_period_length) + 'd' : '--';
  const shortest = stats.shortest_cycle != null ? stats.shortest_cycle + 'd' : '--';
  const longest = stats.longest_cycle != null ? stats.longest_cycle + 'd' : '--';

  let cycleRows = '';
  for (let i = 1; i < completed.length; i++) {
    const len = daysBetweenDates(completed[i - 1].start_date, completed[i].start_date);
    const periodLen = daysBetweenDates(completed[i - 1].start_date, completed[i - 1].end_date) + 1;
    cycleRows += '<tr><td>' + completed[i - 1].start_date + '</td><td>' + completed[i - 1].end_date + '</td><td>' + periodLen + 'd</td><td>' + len + 'd</td></tr>';
  }
  if (completed.length) {
    const last = completed[completed.length - 1];
    const periodLen = daysBetweenDates(last.start_date, last.end_date) + 1;
    cycleRows += '<tr><td>' + last.start_date + '</td><td>' + last.end_date + '</td><td>' + periodLen + 'd</td><td>--</td></tr>';
  }

  const symptomTags = topSymptoms.length
    ? '<div class="tag-list">' + topSymptoms.map(([s, c]) => '<span class="tag">' + (reportNameMap[s] || s) + ' (' + c + ')</span>').join('') + '</div>'
    : '<p>No symptoms logged yet.</p>';
  const moodTags = topMoods.length
    ? '<div class="tag-list">' + topMoods.map(([m, c]) => '<span class="tag">' + m + ' (' + c + ')</span>').join('') + '</div>'
    : '<p>No moods logged yet.</p>';

  const colorCounts = {};
  appData.day_logs.forEach(log => {
    if (log.discharge_color) colorCounts[log.discharge_color] = (colorCounts[log.discharge_color] || 0) + 1;
  });
  const colorEntries = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]);
  const colorTags = colorEntries.length
    ? '<div class="tag-list">' + colorEntries.map(([c, n]) => '<span class="tag">' + c + ' (' + n + ')</span>').join('') + '</div>'
    : '<p>No discharge colors logged yet.</p>';

  const bc = appData.settings.birth_control;
  let bcHTML = '<p>None currently tracked.</p>';
  if (bc && bc.current) {
    bcHTML = '<p>Current: <strong>' + bc.current.method + (bc.current.sub_type ? ' · ' + bc.current.sub_type : '') + '</strong> since ' + bc.current.start_date + '</p>';
    if (bc.history.length) {
      bcHTML += '<table><thead><tr><th>Method</th><th>Start</th><th>End</th></tr></thead><tbody>';
      bc.history.forEach(h => { bcHTML += '<tr><td>' + h.method + '</td><td>' + h.start_date + '</td><td>' + h.end_date + '</td></tr>'; });
      bcHTML += '</tbody></table>';
    }
  }

  return '<!DOCTYPE html><html><head><title>Cykel - Cycle Report</title>' +
    '<style>' +
    'body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 40px auto; color: #1A1714; padding: 0 20px; }' +
    'h1 { font-size: 28px; margin-bottom: 4px; }' +
    '.subtitle { color: #6B6560; font-size: 14px; margin-bottom: 32px; }' +
    'h2 { font-size: 18px; margin: 24px 0 12px; border-bottom: 1px solid #EDE8E2; padding-bottom: 8px; }' +
    '.stat-row { display: flex; gap: 24px; margin-bottom: 8px; }' +
    '.stat-item { font-size: 14px; }' +
    '.stat-item strong { font-size: 20px; display: block; }' +
    'table { width: 100%; border-collapse: collapse; font-size: 14px; }' +
    'th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #EDE8E2; }' +
    'th { font-weight: 600; color: #6B6560; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }' +
    '.tag-list { display: flex; flex-wrap: wrap; gap: 8px; }' +
    '.tag { padding: 4px 12px; border-radius: 20px; font-size: 13px; background: #F2EEEA; }' +
    '.footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #EDE8E2; font-size: 12px; color: #A39E98; }' +
    '@media print { body { margin: 20px; } }' +
    '</style></head><body>' +
    '<h1>Cykel \u2014 Cycle Report</h1>' +
    '<p class="subtitle">' + sixMonthsAgo.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ' \u2013 ' + now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</p>' +
    '<h2>Summary</h2><div class="stat-row">' +
    '<div class="stat-item"><strong>' + avgCycle + '</strong>Avg cycle</div>' +
    '<div class="stat-item"><strong>' + avgPeriod + '</strong>Avg period</div>' +
    '<div class="stat-item"><strong>' + shortest + '</strong>Shortest</div>' +
    '<div class="stat-item"><strong>' + longest + '</strong>Longest</div>' +
    '<div class="stat-item"><strong>' + stats.total_cycles + '</strong>Total cycles</div>' +
    '</div>' +
    '<h2>Cycle History</h2><table><thead><tr><th>Start</th><th>End</th><th>Period</th><th>Cycle</th></tr></thead><tbody>' + cycleRows + '</tbody></table>' +
    '<h2>Common Symptoms</h2>' + symptomTags +
    '<h2>Discharge Colors</h2>' + colorTags +
    '<h2>Common Moods</h2>' + moodTags +
    '<h2>Birth Control</h2>' + bcHTML +
    '<p class="footer">Generated by Cykel \u00b7 ' + now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ' \u00b7 Private & encrypted on-device tracker</p>' +
    '</body></html>';
}

document.getElementById('btn-doctor-report').addEventListener('click', () => {
  if (!appData) return;

  const stats = cycleStats(appData.cycles);
  const completed = appData.cycles
    .filter(c => c.end_date != null)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));

  const symptomCounts = {};
  appData.symptoms.forEach(s => {
    symptomCounts[s.symptom_type] = (symptomCounts[s.symptom_type] || 0) + 1;
  });
  const topSymptoms = Object.entries(symptomCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const moodCounts = {};
  appData.day_logs.forEach(log => {
    if (log.moods) log.moods.forEach(m => { moodCounts[m] = (moodCounts[m] || 0) + 1; });
  });
  const topMoods = Object.entries(moodCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const now = new Date();
  const sixMonthsAgo = new Date(now);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const reportNameMap = { BreastPain: 'Breast Pain', PelvicPressure: 'Pelvic Pressure', HotFlashes: 'Hot Flashes', JointPain: 'Joint Pain', AppetiteChanges: 'Appetite Changes', HeavyDischarge: 'Heavy Discharge', LightDischarge: 'Light Discharge', Cravings: 'Cravings', Diarrhea: 'Diarrhea', Constipation: 'Constipation' };

  const avgCycle = stats.avg_cycle_length ? Math.round(stats.avg_cycle_length) + 'd' : '--';
  const avgPeriod = stats.avg_period_length ? Math.round(stats.avg_period_length) + 'd' : '--';
  const shortest = stats.shortest_cycle != null ? stats.shortest_cycle + 'd' : '--';
  const longest = stats.longest_cycle != null ? stats.longest_cycle + 'd' : '--';

  // Build cycle history rows
  let cycleRows = '';
  for (let i = 1; i < completed.length; i++) {
    const len = daysBetweenDates(completed[i - 1].start_date, completed[i].start_date);
    const periodLen = daysBetweenDates(completed[i - 1].start_date, completed[i - 1].end_date) + 1;
    cycleRows += '<tr><td>' + completed[i - 1].start_date + '</td><td>' + completed[i - 1].end_date + '</td><td>' + periodLen + 'd</td><td>' + len + 'd</td></tr>';
  }
  if (completed.length) {
    const last = completed[completed.length - 1];
    const periodLen = daysBetweenDates(last.start_date, last.end_date) + 1;
    cycleRows += '<tr><td>' + last.start_date + '</td><td>' + last.end_date + '</td><td>' + periodLen + 'd</td><td>--</td></tr>';
  }

  // Discharge color counts
  const colorCounts = {};
  appData.day_logs.forEach(log => {
    if (log.discharge_color) colorCounts[log.discharge_color] = (colorCounts[log.discharge_color] || 0) + 1;
  });
  const colorEntries = Object.entries(colorCounts).sort((a, b) => b[1] - a[1]);

  // Birth control
  const bc = appData.settings.birth_control;
  let bcHTML = '<p class="report-empty">None currently tracked</p>';
  if (bc && bc.current) {
    bcHTML = '<p style="font-size:14px;color:var(--text-secondary)">Current: <strong>' + bc.current.method + '</strong> since ' + bc.current.start_date + '</p>';
    if (bc.history.length) {
      bcHTML += '<table class="report-table"><thead><tr><th>Method</th><th>Start</th><th>End</th></tr></thead><tbody>';
      bc.history.forEach(h => { bcHTML += '<tr><td>' + h.method + '</td><td>' + h.start_date + '</td><td>' + h.end_date + '</td></tr>'; });
      bcHTML += '</tbody></table>';
    }
  }

  // Build in-app report
  const reportBody = document.getElementById('report-body');
  reportBody.innerHTML =
    '<p class="report-date-range">' + sixMonthsAgo.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ' \u2013 ' + now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</p>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Summary</div>' +
    '<div class="report-stat-grid">' +
    '<div class="report-stat"><span class="report-stat-value">' + avgCycle + '</span><span class="report-stat-label">avg cycle</span></div>' +
    '<div class="report-stat"><span class="report-stat-value">' + avgPeriod + '</span><span class="report-stat-label">avg period</span></div>' +
    '<div class="report-stat"><span class="report-stat-value">' + shortest + '</span><span class="report-stat-label">shortest</span></div>' +
    '<div class="report-stat"><span class="report-stat-value">' + longest + '</span><span class="report-stat-label">longest</span></div>' +
    '<div class="report-stat"><span class="report-stat-value">' + stats.total_cycles + '</span><span class="report-stat-label">total cycles</span></div>' +
    '</div></div>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Cycle History</div>' +
    (cycleRows ? '<table class="report-table"><thead><tr><th>Start</th><th>End</th><th>Period</th><th>Cycle</th></tr></thead><tbody>' + cycleRows + '</tbody></table>' : '<p class="report-empty">No completed cycles yet</p>') +
    '</div>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Common Symptoms</div>' +
    (topSymptoms.length
      ? '<div class="report-tags">' + topSymptoms.map(([s, c]) => '<span class="report-tag report-tag-symptom">' + (reportNameMap[s] || s) + ' \u00b7 ' + c + '</span>').join('') + '</div>'
      : '<p class="report-empty">No symptoms logged yet</p>') +
    '</div>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Discharge Colors</div>' +
    (colorEntries.length
      ? '<div class="report-tags">' + colorEntries.map(([c, n]) => '<span class="report-tag">' + c + ' \u00b7 ' + n + '</span>').join('') + '</div>'
      : '<p class="report-empty">No discharge colors logged yet</p>') +
    '</div>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Common Moods</div>' +
    (topMoods.length
      ? '<div class="report-tags">' + topMoods.map(([m, c]) => '<span class="report-tag report-tag-mood">' + m + ' \u00b7 ' + c + '</span>').join('') + '</div>'
      : '<p class="report-empty">No moods logged yet</p>') +
    '</div>' +

    '<div class="report-card">' +
    '<div class="report-card-label">Birth Control</div>' +
    bcHTML +
    '</div>' +

    '<p class="report-footer">Generated by Cykel \u00b7 ' + now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + '<br>Private & encrypted on-device</p>';

  // Store data for print/share
  reportBody.dataset.printHTML = buildReportPrintHTML(stats, completed, topSymptoms, topMoods, reportNameMap, sixMonthsAgo, now);

  // Show overlay
  const overlay = document.getElementById('report-overlay');
  overlay.classList.remove('hidden');
  reportBody.scrollTop = 0;
});

// Close report overlay
document.getElementById('btn-report-close').addEventListener('click', () => {
  document.getElementById('report-overlay').classList.add('hidden');
});

// Print report
document.getElementById('btn-report-print').addEventListener('click', () => {
  const printHTML = document.getElementById('report-body').dataset.printHTML;
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(printHTML);
    win.document.close();
    setTimeout(() => win.print(), 400);
  } else {
    window.print();
  }
});

// Share report
document.getElementById('btn-report-share').addEventListener('click', async () => {
  const reportBody = document.getElementById('report-body');
  const printHTML = reportBody.dataset.printHTML;
  const textContent = reportBody.innerText;

  if (navigator.share) {
    try {
      const blob = new Blob([printHTML], { type: 'text/html' });
      const file = new File([blob], 'cykel-cycle-report.html', { type: 'text/html' });
      await navigator.share({
        title: 'Cykel - Cycle Report',
        text: textContent.substring(0, 200),
        files: [file]
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        try {
          await navigator.share({
            title: 'Cykel - Cycle Report',
            text: textContent
          });
        } catch (_) {}
      }
    }
  } else {
    await navigator.clipboard.writeText(textContent);
    const btn = document.getElementById('btn-report-share');
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
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
document.getElementById('btn-copy-ln').addEventListener('click', () => {
  const addr = document.getElementById('lightning-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => {
    const btn = document.getElementById('btn-copy-ln');
    btn.textContent = 'Copied!';
    btn.classList.add('btn-copied');
    haptic('success');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('btn-copied'); }, 2000);
  });
});

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
// Birth Control
// ============================================

function renderBirthControl() {
  if (!appData) return;
  const bc = appData.settings.birth_control || { current: null, history: [] };
  appData.settings.birth_control = bc;

  const desc = document.getElementById('bc-current-desc');
  const methodLabel = bc.current
    ? (bc.current.sub_type ? `${bc.current.method} · ${bc.current.sub_type}` : bc.current.method)
    : 'None';
  desc.textContent = bc.current ? `${methodLabel} since ${fmtDatePretty(bc.current.start_date)}` : 'None';

  // Render history
  const historySection = document.getElementById('bc-history');
  const historyList = document.getElementById('bc-history-list');
  historyList.innerHTML = '';

  if (bc.history.length > 0) {
    historySection.classList.remove('hidden');
    bc.history.slice().reverse().forEach(h => {
      const item = document.createElement('div');
      item.className = 'bc-history-item';
      const histLabel = h.sub_type ? `${h.method} · ${h.sub_type}` : h.method;
      item.innerHTML = `<span class="bc-history-method">${histLabel}</span><span class="bc-history-dates">${fmtDateShort(h.start_date)} — ${fmtDateShort(h.end_date)}</span>`;
      historyList.appendChild(item);
    });
  } else {
    historySection.classList.add('hidden');
  }
}

let bcSelectedMethod = null;
let bcSelectedSubType = null;

// Sub-types for each birth control method
const BC_SUB_TYPES = {
  Pill: ['Combo (estrogen + progestin)', 'Mini-pill (progestin only)'],
  IUD: ['Hormonal (Mirena, Kyleena)', 'Copper (Paragard)'],
  Implant: ['Nexplanon'],
  Patch: ['Xulane', 'Twirla'],
  Ring: ['NuvaRing', 'Annovera'],
  Shot: ['Depo-Provera'],
  Condom: ['External (male)', 'Internal (female)'],
  Natural: ['FAM / rhythm', 'Withdrawal', 'Tracking only']
};

function updateBcSubSelector() {
  const subContainer = document.getElementById('bc-sub-selector');
  const subOptions = document.getElementById('bc-sub-options');
  const subs = BC_SUB_TYPES[bcSelectedMethod];

  if (!subs || bcSelectedMethod === 'None') {
    subContainer.classList.add('hidden');
    bcSelectedSubType = null;
    return;
  }

  subContainer.classList.remove('hidden');
  subOptions.innerHTML = subs.map(s =>
    `<button class="bc-sub-opt${s === bcSelectedSubType ? ' active' : ''}" data-sub="${s}">${s}</button>`
  ).join('');
}

document.getElementById('btn-bc-change').addEventListener('click', () => {
  const selector = document.getElementById('bc-selector');
  selector.classList.toggle('hidden');
  if (!selector.classList.contains('hidden')) {
    const bc = appData.settings.birth_control || { current: null, history: [] };
    bcSelectedMethod = bc.current ? bc.current.method : 'None';
    bcSelectedSubType = bc.current ? (bc.current.sub_type || null) : null;
    updateBcGrid();
    updateBcSubSelector();
    const dateRow = document.getElementById('bc-date-row');
    dateRow.classList.toggle('hidden', bcSelectedMethod === 'None');
    document.getElementById('bc-start-date').value = bc.current ? bc.current.start_date : fmtDate(new Date());
  }
});

function updateBcGrid() {
  document.querySelectorAll('#bc-grid .bc-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bc === bcSelectedMethod);
  });
}

document.getElementById('bc-grid').addEventListener('click', e => {
  const btn = e.target.closest('.bc-opt');
  if (!btn) return;
  haptic();
  bcSelectedMethod = btn.dataset.bc;
  bcSelectedSubType = null;
  updateBcGrid();
  updateBcSubSelector();
  document.getElementById('bc-date-row').classList.toggle('hidden', bcSelectedMethod === 'None');
});

document.getElementById('bc-sub-options').addEventListener('click', e => {
  const btn = e.target.closest('.bc-sub-opt');
  if (!btn) return;
  haptic();
  bcSelectedSubType = btn.dataset.sub;
  document.querySelectorAll('#bc-sub-options .bc-sub-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.sub === bcSelectedSubType);
  });
});

document.getElementById('btn-bc-save').addEventListener('click', async () => {
  if (!appData) return;
  const bc = appData.settings.birth_control || { current: null, history: [] };

  // Archive current method if switching
  if (bc.current && bc.current.method !== bcSelectedMethod) {
    bc.history.push({
      method: bc.current.method,
      sub_type: bc.current.sub_type || null,
      start_date: bc.current.start_date,
      end_date: fmtDate(new Date())
    });
  }

  if (bcSelectedMethod === 'None') {
    bc.current = null;
  } else {
    const startDate = document.getElementById('bc-start-date').value || fmtDate(new Date());
    bc.current = { method: bcSelectedMethod, sub_type: bcSelectedSubType, start_date: startDate };
  }

  appData.settings.birth_control = bc;
  await saveData();
  document.getElementById('bc-selector').classList.add('hidden');
  renderBirthControl();
});

// ============================================
// Color Customizer
// ============================================

const COLOR_PALETTES = {
  period:   ['#C4654A', '#E85D75', '#D94F8A', '#B35840', '#E8849B', '#C94040', '#D97B4A', '#8B4A6B'],
  spotting: ['#F0DDD7', '#F5C4D0', '#E8D0C8', '#F0C8B8', '#FBE2E0', '#D4B8C8', '#F2D0E0', '#E0C4B0'],
  symptoms: ['#8BA889', '#6BAF8D', '#7BC4A0', '#5A9E78', '#A3C4A0', '#68A090', '#4A8B6E', '#88B8A8'],
  predicted:['#C4654A', '#E85D75', '#7B68C4', '#5A8BC4', '#C49A4A', '#8B6BC4', '#4AA0C4', '#C4784A'],
  fertile:  ['#7B68C4', '#8B5AC4', '#6B7BC4', '#A068C4', '#5A68D4', '#9B68A4', '#6858B4', '#7B88D4']
};

const COLOR_DEFAULTS = {
  period: '#C4654A', spotting: '#F0DDD7', symptoms: '#8BA889',
  predicted: '#C4654A', fertile: '#7B68C4'
};

function applyCustomColors() {
  if (!appData || !appData.settings.custom_colors) return;
  const colors = appData.settings.custom_colors;
  const root = document.documentElement;

  if (colors.period) {
    root.style.setProperty('--accent', colors.period);
    root.style.setProperty('--accent-hover', colors.period);
    root.style.setProperty('--accent-bg', colors.period + '14');
    root.style.setProperty('--accent-bg-strong', colors.period + '26');
    root.style.setProperty('--accent-glow', colors.period + '59');
    root.style.setProperty('--flow-heavy', colors.period);
    root.style.setProperty('--flow-medium', colors.period + 'CC');
    root.style.setProperty('--flow-light', colors.period + '66');
    root.style.setProperty('--predicted', colors.period + '2E');
  }
  if (colors.spotting) {
    root.style.setProperty('--flow-spotting', colors.spotting);
  }
  if (colors.symptoms) {
    root.style.setProperty('--symptom', colors.symptoms);
    root.style.setProperty('--symptom-bg', colors.symptoms + '1F');
    root.style.setProperty('--symptom-bg-strong', colors.symptoms + '38');
  }
  if (colors.predicted && colors.predicted !== colors.period) {
    root.style.setProperty('--predicted', colors.predicted + '2E');
  }
  if (colors.fertile) {
    root.style.setProperty('--fertile', colors.fertile);
    root.style.setProperty('--fertile-bg', colors.fertile + '1F');
    root.style.setProperty('--fertile-bg-strong', colors.fertile + '38');
    root.style.setProperty('--fertile-glow', colors.fertile + '66');
  }
}

function renderColorCustomizer() {
  if (!appData) return;
  const colors = appData.settings.custom_colors || { ...COLOR_DEFAULTS };
  appData.settings.custom_colors = colors;

  Object.keys(COLOR_PALETTES).forEach(key => {
    const swatch = document.getElementById('swatch-' + key);
    const palette = document.getElementById('palette-' + key);
    if (!swatch || !palette) return;

    const current = colors[key] || COLOR_DEFAULTS[key];
    swatch.style.background = current;

    palette.innerHTML = COLOR_PALETTES[key].map(c =>
      `<div class="color-pick${c === current ? ' active' : ''}" data-color="${c}" style="background:${c}"></div>`
    ).join('');
  });
}

document.getElementById('color-customizer').addEventListener('click', async (e) => {
  // Handle color pick selection
  const pick = e.target.closest('.color-pick');
  if (pick) {
    const item = pick.closest('.color-item');
    const key = item.dataset.colorKey;
    const color = pick.dataset.color;
    haptic();

    appData.settings.custom_colors[key] = color;
    await saveData();

    // Update UI
    item.querySelectorAll('.color-pick').forEach(d => d.classList.toggle('active', d.dataset.color === color));
    document.getElementById('swatch-' + key).style.background = color;
    applyCustomColors();
    renderCalendar();
    return;
  }

  // Handle row tap to toggle palette
  const row = e.target.closest('.color-row');
  if (row) {
    haptic('light');
    const item = row.closest('.color-item');
    const palette = item.querySelector('.color-palette');
    const wasOpen = !palette.classList.contains('hidden');

    // Close all palettes and remove open state
    document.querySelectorAll('.color-item').forEach(i => {
      i.classList.remove('open');
      i.querySelector('.color-palette').classList.add('hidden');
    });

    // Toggle this one
    if (!wasOpen) {
      palette.classList.remove('hidden');
      item.classList.add('open');
    }
  }
});

// ============================================
// Flo Import
// ============================================

document.getElementById('btn-import').addEventListener('click', () => {
  if (!appData) return;
  showModal(
    'Import from Flo?',
    'Select a CSV file exported from Flo. Your file is processed entirely on-device — it never leaves your phone. Existing Cykel data takes priority and won\'t be overwritten.',
    'Choose File',
    () => document.getElementById('import-file-input').click()
  );
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  try {
    const text = await file.text();
    const parsed = parseFloCsv(text);

    if (!parsed.days.length) {
      showModal('No data found', 'Couldn\'t find any cycle data in this file. Make sure it\'s a Flo CSV export.', 'OK', () => {});
      return;
    }

    // Show preview
    const dateRange = `${fmtDatePretty(parsed.days[0].date)} — ${fmtDatePretty(parsed.days[parsed.days.length - 1].date)}`;
    showModal(
      `Import ${parsed.days.length} days?`,
      `Found ${parsed.days.length} logged days (${dateRange}). Only days without existing Cykel data will be imported.`,
      'Import',
      async () => {
        const result = mergeFloData(parsed);
        appData.cycles = rebuildCycles(appData.day_logs);
        await saveData();
        renderCalendar();
        showModal('Import complete', `Added ${result.added} days of data. ${result.skipped} days skipped (already had data).`, 'OK', () => {});
      }
    );
  } catch {
    showModal('Import failed', 'Could not read this file. Make sure it\'s a valid CSV from Flo.', 'OK', () => {});
  }
});

function parseFloCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { days: [] };

  const header = lines[0].toLowerCase();
  const cols = header.split(',').map(c => c.trim().replace(/"/g, ''));

  // Find column indices — Flo exports vary, so be flexible
  const dateIdx = cols.findIndex(c => c === 'date' || c.includes('date'));
  const flowIdx = cols.findIndex(c => c === 'period flow' || c === 'flow' || c.includes('period'));
  const sympIdx = cols.findIndex(c => c === 'symptoms' || c.includes('symptom'));
  const moodIdx = cols.findIndex(c => c === 'mood' || c.includes('mood'));
  const notesIdx = cols.findIndex(c => c === 'notes' || c.includes('note'));

  if (dateIdx < 0) return { days: [] };

  const days = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    if (row.length <= dateIdx) continue;

    const rawDate = row[dateIdx].trim();
    const date = normalizeDate(rawDate);
    if (!date) continue;

    const day = { date };

    // Flow
    if (flowIdx >= 0 && row[flowIdx]) {
      const f = row[flowIdx].trim().toLowerCase();
      if (f.includes('heavy')) day.flow_level = 'Heavy';
      else if (f.includes('medium')) day.flow_level = 'Medium';
      else if (f.includes('light')) day.flow_level = 'Light';
      else if (f.includes('spot')) day.flow_level = 'Spotting';
    }

    // Symptoms
    if (sympIdx >= 0 && row[sympIdx]) {
      day.symptoms = matchSymptoms(row[sympIdx]);
    }

    // Moods
    if (moodIdx >= 0 && row[moodIdx]) {
      day.moods = matchMoods(row[moodIdx]);
    }

    // Notes
    if (notesIdx >= 0 && row[notesIdx]) {
      day.notes = row[notesIdx].trim();
    }

    // Only include days that have actual data
    if (day.flow_level || (day.symptoms && day.symptoms.length) || (day.moods && day.moods.length) || day.notes) {
      days.push(day);
    }
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days };
}

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function normalizeDate(raw) {
  // Try YYYY-MM-DD first
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // Try MM/DD/YYYY
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // Try DD/MM/YYYY
  const dmy = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  // Try Date.parse as last resort
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return fmtDate(d);
  return null;
}

const FLO_SYMPTOM_MAP = {
  cramp: 'Cramps', headache: 'Headache', backache: 'Backache', back: 'Backache',
  bloat: 'Bloating', breast: 'BreastPain', tender: 'BreastPain', nausea: 'Nausea',
  fatigue: 'Fatigue', tired: 'Fatigue', acne: 'Acne', pimple: 'Acne',
  hot: 'HotFlashes', flash: 'HotFlashes', dizz: 'Dizziness', joint: 'JointPain',
  insomnia: 'Insomnia', sleep: 'Insomnia', crav: 'Cravings', diarr: 'Diarrhea',
  constip: 'Constipation', pelvi: 'PelvicPressure', appetite: 'AppetiteChanges'
};

function matchSymptoms(text) {
  const lower = text.toLowerCase();
  const matched = new Set();
  for (const [key, value] of Object.entries(FLO_SYMPTOM_MAP)) {
    if (lower.includes(key)) matched.add(value);
  }
  return [...matched];
}

const FLO_MOOD_MAP = {
  happy: 'Happy', calm: 'Calm', sensit: 'Sensitive', anxio: 'Anxious',
  irritab: 'Irritable', sad: 'Sad', mood: 'MoodSwings', swing: 'MoodSwings',
  energ: 'Energetic'
};

function matchMoods(text) {
  const lower = text.toLowerCase();
  const matched = new Set();
  for (const [key, value] of Object.entries(FLO_MOOD_MAP)) {
    if (lower.includes(key)) matched.add(value);
  }
  return [...matched];
}

function mergeFloData(parsed) {
  let added = 0;
  let skipped = 0;
  const existingDates = new Set(appData.day_logs.map(l => l.date));

  for (const day of parsed.days) {
    if (existingDates.has(day.date)) {
      skipped++;
      continue;
    }

    // Add day log
    const logData = {
      date: day.date,
      flow_level: day.flow_level || 'None',
      moods: day.moods || [],
      discharge: null,
      discharge_color: null,
      sex: null,
      sex_drive: null,
      energy: null,
      sleep: null,
      exercise: null,
      notes: day.notes || '',
    };
    appData.day_logs.push(logData);

    // Add symptoms
    if (day.symptoms) {
      for (const sym of day.symptoms) {
        appData.symptoms.push({ date: day.date, symptom_type: sym, severity: 2 });
      }
    }

    added++;
  }

  return { added, skipped };
}

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
// Period Panda — Chat
// ============================================

const PANDA_SVG = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <g class="panda-body">
    <!-- Ears -->
    <circle cx="24" cy="24" r="14" fill="#F2A0B5"/>
    <circle cx="76" cy="24" r="14" fill="#F2A0B5"/>
    <circle cx="24" cy="24" r="7" fill="#F7C4D0" opacity="0.8"/>
    <circle cx="76" cy="24" r="7" fill="#F7C4D0" opacity="0.8"/>
    <!-- Head -->
    <circle cx="50" cy="52" r="38" fill="#F2A0B5"/>
    <!-- Face -->
    <ellipse cx="50" cy="56" rx="28" ry="26" fill="#FFF5F7"/>
    <!-- Eye patches -->
    <ellipse cx="36" cy="48" rx="12" ry="10" fill="#E88DA3"/>
    <ellipse cx="64" cy="48" rx="12" ry="10" fill="#E88DA3"/>
    <!-- Eyes (blink targets) -->
    <g class="panda-eyes">
      <ellipse cx="36" cy="48" rx="5" ry="5.5" fill="#FFF5F7"/>
      <ellipse cx="64" cy="48" rx="5" ry="5.5" fill="#FFF5F7"/>
      <circle class="panda-pupil-l" cx="37" cy="48" r="2.8" fill="#5A3044"/>
      <circle class="panda-pupil-r" cx="65" cy="48" r="2.8" fill="#5A3044"/>
      <!-- Sparkle dots (hidden by default, shown in happy state) -->
      <circle class="panda-sparkle" cx="34" cy="45" r="1.2" fill="white" opacity="0"/>
      <circle class="panda-sparkle" cx="62" cy="45" r="1.2" fill="white" opacity="0"/>
    </g>
    <!-- Nose -->
    <ellipse cx="50" cy="57" rx="4" ry="2.8" fill="#5A3044"/>
    <!-- Mouth -->
    <path d="M46 61 Q50 65 54 61" fill="none" stroke="#5A3044" stroke-width="1.5" stroke-linecap="round" class="panda-mouth"/>
    <!-- Cheeks -->
    <circle cx="28" cy="60" r="5.5" fill="#F7C4D0" opacity="0.5"/>
    <circle cx="72" cy="60" r="5.5" fill="#F7C4D0" opacity="0.5"/>
  </g>
</svg>`;

const PANDA_SVG_MINI = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <g class="panda-body">
    <circle cx="24" cy="24" r="14" fill="#F2A0B5"/>
    <circle cx="76" cy="24" r="14" fill="#F2A0B5"/>
    <circle cx="24" cy="24" r="7" fill="#F7C4D0" opacity="0.8"/>
    <circle cx="76" cy="24" r="7" fill="#F7C4D0" opacity="0.8"/>
    <circle cx="50" cy="52" r="38" fill="#F2A0B5"/>
    <ellipse cx="50" cy="56" rx="28" ry="26" fill="#FFF5F7"/>
    <ellipse cx="36" cy="48" rx="12" ry="10" fill="#E88DA3"/>
    <ellipse cx="64" cy="48" rx="12" ry="10" fill="#E88DA3"/>
    <g class="panda-eyes">
      <ellipse cx="36" cy="48" rx="5" ry="5.5" fill="#FFF5F7"/>
      <ellipse cx="64" cy="48" rx="5" ry="5.5" fill="#FFF5F7"/>
      <circle cx="37" cy="48" r="2.8" fill="#5A3044"/>
      <circle cx="65" cy="48" r="2.8" fill="#5A3044"/>
    </g>
    <ellipse cx="50" cy="57" rx="4" ry="2.8" fill="#5A3044"/>
    <path d="M46 61 Q50 65 54 61" fill="none" stroke="#5A3044" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="28" cy="60" r="5.5" fill="#F7C4D0" opacity="0.5"/>
    <circle cx="72" cy="60" r="5.5" fill="#F7C4D0" opacity="0.5"/>
  </g>
</svg>`;

let pandaChatOpen = false;

function pandaSuggestions() {
  // Pick 6 random questions from the KB
  const shuffled = [...pandaKB].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 6);
}

// Conversation context for follow-up awareness
let pandaContext = { lastCategory: null, lastEntryId: null, lastKeywords: [], turnCount: 0 };

// Detect if a message is a vague follow-up that needs context
const FOLLOWUP_PATTERNS = /^(what (should|can|do) i|how (do|should|can) i|is that|should i|and |but |also |what about|tell me more|more about|what else|okay |ok |so |like what|what if|how long|when should|can you|really|why|what now|how about|does that|will it|and what|is it)/i;
const PRONOUN_HEAVY = /^(it|that|this|they|them|those|these)\b/i;

function matchPandaAnswer(query) {
  const cleaned = query.toLowerCase().replace(/[?.,!'"]/g, '');
  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  const isFollowUp = FOLLOWUP_PATTERNS.test(cleaned.trim()) || (words.length <= 4 && PRONOUN_HEAVY.test(cleaned.trim()));

  let bestScore = 0;
  let bestEntry = null;

  for (const entry of pandaKB) {
    let score = 0;

    // Keyword matching
    for (const word of words) {
      for (const kw of entry.keywords) {
        if (kw === word) score += 3;
        else if (kw.includes(word) || word.includes(kw)) score += 1.5;
      }
    }

    // Boost if query words appear in the question text
    const qLower = entry.q.toLowerCase();
    for (const word of words) {
      if (qLower.includes(word)) score += 0.5;
    }

    // Boost if query words match answer text (catches contextual terms)
    const aLower = entry.answer.toLowerCase();
    for (const word of words) {
      if (aLower.includes(word)) score += 0.3;
    }

    // Context boost: if this looks like a follow-up, bias toward same category/related entries
    if (isFollowUp && pandaContext.lastCategory) {
      if (entry.category === pandaContext.lastCategory) score += 2.5;
      // Also check if user's words overlap with keywords from the last answer's entry
      for (const word of words) {
        for (const prevKw of pandaContext.lastKeywords) {
          if (prevKw === word || prevKw.includes(word) || word.includes(prevKw)) score += 1;
        }
      }
    }

    // Small penalty for repeating the exact same entry
    if (entry.id === pandaContext.lastEntryId) score -= 1.5;

    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  // For follow-ups, lower the threshold since context fills in meaning
  const threshold = isFollowUp ? 1.5 : 2;

  if (bestScore >= threshold && bestEntry) {
    // Update context
    pandaContext.lastCategory = bestEntry.category;
    pandaContext.lastEntryId = bestEntry.id;
    pandaContext.lastKeywords = bestEntry.keywords;
    pandaContext.turnCount++;
    return bestEntry.answer;
  }

  // If it's a follow-up and we have context but couldn't match, give a context-aware fallback
  if (isFollowUp && pandaContext.lastCategory) {
    const categoryNames = {
      'cycle-basics': 'your cycle', 'symptoms': 'symptoms', 'discharge': 'discharge',
      'fertility': 'fertility', 'pregnancy': 'pregnancy', 'postpartum': 'postpartum recovery',
      'birth-control': 'birth control', 'sexual-health': 'sexual health',
      'perimenopause': 'perimenopause', 'doctor': 'seeing a doctor',
      'lifestyle': 'lifestyle', 'privacy': 'your data', 'conditions': 'health conditions'
    };
    const topic = categoryNames[pandaContext.lastCategory] || 'that topic';
    return "i want to help but i'm not sure what you're asking about " + topic + ". can you rephrase? like \"what are the symptoms of...\" or \"is it normal to...\" — that helps me find the right answer for you.";
  }

  pandaContext.turnCount++;
  return "hmm, i'm not sure about that one. try asking about periods, pregnancy, postpartum, fertility, discharge, birth control, sexual health, symptoms, or when to see a doctor — i know a lot about those.";
}

function openPandaChat() {
  if (pandaChatOpen) return;
  pandaChatOpen = true;
  haptic('light');

  const suggestions = pandaSuggestions();

  const overlay = document.createElement('div');
  overlay.className = 'panda-overlay';
  overlay.innerHTML = `
    <div class="panda-sheet">
      <div class="panda-handle"></div>
      <div class="panda-header">
        <div class="panda-header-avatar panda-anim-idle">${PANDA_SVG_MINI}</div>
        <span class="panda-title">Period Panda</span>
        <button class="panda-close" aria-label="Close">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="panda-disclaimer">${DISCLAIMER}</div>
      <div class="panda-messages">
        <div class="panda-welcome">
          <div class="panda-welcome-avatar panda-anim-wave">${PANDA_SVG}</div>
          <div class="panda-welcome-title">hey, i'm period panda</div>
          <div class="panda-welcome-sub">ask me anything about your cycle, symptoms, discharge, fertility, or just how your body works. no judgement, no data leaves your phone.</div>
        </div>
      </div>
      <div class="panda-suggestions">${suggestions.map(s => `<button class="panda-chip">${s.q}</button>`).join('')}</div>
      <div class="panda-input-row">
        <input type="text" class="panda-input" placeholder="ask period panda..." maxlength="200" />
        <button class="panda-send" aria-label="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  `;

  document.getElementById('app').appendChild(overlay);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      overlay.classList.add('panda-visible');
    });
  });

  const messagesEl = overlay.querySelector('.panda-messages');
  const suggestionsEl = overlay.querySelector('.panda-suggestions');
  const inputEl = overlay.querySelector('.panda-input');
  const sendBtn = overlay.querySelector('.panda-send');
  const headerAvatar = overlay.querySelector('.panda-header-avatar');

  function closePanda() {
    overlay.classList.remove('panda-visible');
    setTimeout(() => {
      overlay.remove();
      pandaChatOpen = false;
      pandaContext = { lastCategory: null, lastEntryId: null, lastKeywords: [], turnCount: 0 };
    }, 500);
  }

  function addMessage(text, isUser) {
    // Remove welcome on first message
    const welcome = messagesEl.querySelector('.panda-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `panda-msg ${isUser ? 'panda-msg-user' : 'panda-msg-panda'}`;
    if (!isUser) {
      msg.innerHTML = `<span class="panda-msg-avatar">🐼</span>${text}`;
    } else {
      msg.textContent = text;
    }
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function showTyping() {
    const typing = document.createElement('div');
    typing.className = 'panda-typing';
    typing.innerHTML = '<div class="panda-typing-dot"></div><div class="panda-typing-dot"></div><div class="panda-typing-dot"></div>';
    messagesEl.appendChild(typing);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    headerAvatar.classList.remove('panda-anim-idle');
    headerAvatar.classList.add('panda-anim-thinking');
    return typing;
  }

  function sendMessage(text) {
    if (!text.trim()) return;
    addMessage(text, true);
    haptic('light');

    // Hide suggestions after first message, show related ones later
    suggestionsEl.innerHTML = '';

    const typing = showTyping();

    // Simulate thinking time
    const delay = 300 + Math.random() * 400;
    setTimeout(() => {
      typing.remove();
      const answer = matchPandaAnswer(text);
      addMessage(answer, false);
      haptic('success');

      // Switch to happy state briefly
      headerAvatar.classList.remove('panda-anim-thinking');
      headerAvatar.classList.add('panda-anim-happy');
      setTimeout(() => {
        headerAvatar.classList.remove('panda-anim-happy');
        headerAvatar.classList.add('panda-anim-idle');
      }, 1500);

      // Show new suggestions
      const newSuggestions = pandaSuggestions();
      suggestionsEl.innerHTML = newSuggestions.map(s => `<button class="panda-chip">${s.q}</button>`).join('');
    }, delay);

    inputEl.value = '';
    if (typeof resetAutoLock === 'function') resetAutoLock();
  }

  // Event listeners
  overlay.querySelector('.panda-close').addEventListener('click', closePanda);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePanda();
  });

  sendBtn.addEventListener('click', () => sendMessage(inputEl.value));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage(inputEl.value);
  });

  // Suggestion chip clicks (event delegation)
  suggestionsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.panda-chip');
    if (chip) {
      haptic('light');
      sendMessage(chip.textContent);
    }
  });

  // Swipe down to close
  let startY = 0;
  const header = overlay.querySelector('.panda-header');
  header.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; });
  header.addEventListener('touchend', (e) => {
    const diff = e.changedTouches[0].clientY - startY;
    if (diff > 60) closePanda();
  });

  // Auto-send pending question from hint bubble
  if (pandaPendingQuestion) {
    const q = pandaPendingQuestion;
    pandaPendingQuestion = null;
    setTimeout(() => sendMessage(q), 600);
  }
}

// ============================================
// Panda Hint Bubble
// ============================================

let pandaPendingQuestion = null;
let pandaHintDismissCount = 0;

const PANDA_HINTS = {
  period: [
    'Why are my cramps so bad rn?',
    'Can I swim on my period?',
    'Is it normal to get clots?',
    'Why do I poop more on my period?',
    'Period headaches — why?',
    'Why does my back hurt?',
    'Does alcohol make it worse?',
    'Why am I so tired?',
    'Can I exercise right now?',
    'Is nausea normal during periods?',
    'Why is my period blood dark?',
    'How do I deal with cramps?'
  ],
  luteal: [
    'Why am I so bloated?',
    'Cravings are wild — is that normal?',
    'Why are my mood swings so intense?',
    'Can\'t sleep before my period',
    'Breakout on my chin again',
    'Why do my boobs hurt?',
    'What is PMS exactly?',
    'Why am I so emotional rn?',
    'Hormonal acne help',
    'Why am I gaining weight?',
    'What is the luteal phase?',
    'Can stress delay my period?'
  ],
  fertile: [
    'When am I most fertile?',
    'What does egg white discharge mean?',
    'Can I get pregnant right now?',
    'What is ovulation exactly?',
    'Ovulation pain — is that normal?',
    'How do I know when I\'m ovulating?',
    'Does sex drive change mid-cycle?',
    'What is BBT tracking?',
    'Do fertility supplements work?',
    'How does age affect fertility?'
  ],
  late: [
    'Why is my period late?',
    'Should I take a pregnancy test?',
    'Can stress delay my period?',
    'What are early pregnancy symptoms?',
    'Late period but negative test?',
    'What is implantation bleeding?',
    'Could I be pregnant?',
    'When is a test accurate?',
    'I haven\'t had my period in months'
  ],
  pregnancy: [
    'What size is my baby this week?',
    'Is this cramping normal?',
    'What foods should I avoid?',
    'Morning sickness help',
    'Can I exercise during pregnancy?',
    'What are Braxton Hicks?',
    'How do I know if I\'m in labor?',
    'What is gestational diabetes?',
    'How much weight should I gain?',
    'Feeling anxious — is that normal?',
    'What is preeclampsia?',
    'Why can\'t I sleep?'
  ],
  postpartum: [
    'When does my period come back?',
    'Is postpartum anxiety a thing?',
    'Why is my hair falling out?',
    'When can I have sex after birth?',
    'What is diastasis recti?',
    'What is postpartum depression?',
    'How long do you bleed after birth?',
    'Does breastfeeding affect my cycle?',
    'Postpartum rage — is that real?',
    'What is the postpartum period?',
    'Pelvic floor — what now?',
    'When will my body feel normal?'
  ],
  default: [
    'Ask me anything about your cycle',
    'Is my discharge normal?',
    'When should I see a doctor?',
    'What\'s a normal cycle length?',
    'How does birth control affect me?',
    'What is PCOS?',
    'Can my thyroid affect my period?',
    'How do I prevent UTIs?',
    'What period products are there?',
    'Does diet affect my period?',
    'Is it normal for sex to be painful?',
    'Why is Cykel open source?'
  ]
};

function getCyclePhaseForHint() {
  if (!appData) return 'default';
  if (appMode === 'pregnancy') return 'pregnancy';

  // Check for postpartum (recently switched from pregnancy)
  const pred = predict(appData.cycles);
  const fw = showFertility ? fertilityWindow(appData.cycles) : null;
  const today = fmtDate(new Date());

  // Check if currently on period
  const activeCycle = appData.cycles.find(c => !c.end_date);
  if (activeCycle) {
    const daysSinceStart = daysBetweenDates(activeCycle.start_date, today);
    if (daysSinceStart <= 7) return 'period';
  }

  // Check if period is late
  if (pred && pred.next_period_start) {
    const daysUntilPeriod = daysBetweenDates(today, pred.next_period_start);
    if (daysUntilPeriod < -3) return 'late';
  }

  // Check fertile window
  if (fw && fw.fertile_start && fw.fertile_end) {
    if (today >= fw.fertile_start && today <= fw.fertile_end) return 'fertile';
  }

  // Check if in luteal phase (after ovulation, before predicted period)
  if (pred && pred.next_period_start) {
    const daysUntilPeriod = daysBetweenDates(today, pred.next_period_start);
    if (daysUntilPeriod >= 0 && daysUntilPeriod <= 14) return 'luteal';
  }

  return 'default';
}

function showPandaHint() {
  // Don't show if user has dismissed enough times or if panda chat is open
  if (pandaHintDismissCount >= 3 || pandaChatOpen) return;

  const hintEl = document.getElementById('panda-hint');
  const hintText = document.getElementById('panda-hint-text');
  if (!hintEl || !hintText) return;

  const phase = getCyclePhaseForHint();
  const hints = PANDA_HINTS[phase] || PANDA_HINTS.default;
  const hint = hints[Math.floor(Math.random() * hints.length)];

  hintText.textContent = '🐼 ' + hint;
  hintEl.dataset.question = hint;
  hintEl.classList.remove('hidden');

  // Auto-hide after 8 seconds
  setTimeout(() => {
    if (!hintEl.classList.contains('hidden')) {
      hintEl.classList.add('hidden');
    }
  }, 8000);
}

// Contextual smart chips on calendar
function renderPandaChips() {
  const container = document.getElementById('panda-chips');
  if (!container || !appData) return;

  const phase = getCyclePhaseForHint();
  const pool = PANDA_HINTS[phase] || PANDA_HINTS.default;

  // Shuffle and pick 8
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const chips = shuffled.slice(0, 8);

  container.innerHTML = chips.map(q =>
    `<button class="panda-smart-chip" data-question="${q.replace(/"/g, '&quot;')}">${q}</button>`
  ).join('');
  container.classList.remove('hidden');
}

// Smart chip click → open panda with that question
document.getElementById('panda-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.panda-smart-chip');
  if (!chip) return;
  haptic('light');
  pandaPendingQuestion = chip.dataset.question;
  document.getElementById('panda-hint').classList.add('hidden');
  openPandaChat();
});

// Hint bubble click → open panda with pre-filled question
document.getElementById('panda-hint').addEventListener('click', () => {
  const hintEl = document.getElementById('panda-hint');
  const question = hintEl.dataset.question;
  hintEl.classList.add('hidden');
  pandaHintDismissCount++;

  if (question) {
    pandaPendingQuestion = question;
    openPandaChat();
  }
});

// FAB click + drag
(() => {
  const fab = document.getElementById('btn-panda');
  const hint = document.getElementById('panda-hint');
  let isDragging = false;
  let startX, startY, startLeft, startTop;
  let moved = false;

  function getFabPos() {
    const rect = fab.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  fab.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    const pos = getFabPos();
    startX = touch.clientX;
    startY = touch.clientY;
    startLeft = pos.left;
    startTop = pos.top;
    moved = false;
    isDragging = false;
  }, { passive: true });

  fab.addEventListener('touchmove', (e) => {
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    if (!isDragging && Math.abs(dx) + Math.abs(dy) > 10) {
      isDragging = true;
      fab.style.animation = 'none';
      fab.style.transition = 'none';
    }

    if (isDragging) {
      moved = true;
      e.preventDefault();
      const newLeft = Math.max(8, Math.min(window.innerWidth - 68, startLeft + dx));
      const newTop = Math.max(8, Math.min(window.innerHeight - 68, startTop + dy));
      fab.style.left = newLeft + 'px';
      fab.style.top = newTop + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      hint.classList.add('hidden');
    }
  }, { passive: false });

  fab.addEventListener('touchend', () => {
    if (isDragging) {
      // Snap to nearest edge
      const rect = fab.getBoundingClientRect();
      const centerX = rect.left + 30;
      const snapRight = centerX > window.innerWidth / 2;

      fab.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
      fab.style.left = snapRight ? 'auto' : '16px';
      fab.style.right = snapRight ? '16px' : 'auto';
      fab.style.bottom = Math.max(16, window.innerHeight - rect.bottom + rect.height / 2 - 30) + 'px';
      fab.style.top = 'auto';

      setTimeout(() => {
        fab.style.animation = '';
      }, 400);

      isDragging = false;
      return;
    }

    if (!moved) {
      hint.classList.add('hidden');
      openPandaChat();
    }
  });

  // Desktop fallback
  fab.addEventListener('click', (e) => {
    if (moved) { moved = false; return; }
    hint.classList.add('hidden');
    openPandaChat();
  });
})();

// ============================================
// Boot
// ============================================

init();
