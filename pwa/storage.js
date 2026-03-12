// ============================================
// Cykel PWA — Encrypted IndexedDB Storage v3
// Multi-method unlock: passphrase + PIN + biometric
// ============================================

import {
  generateMasterKey, wrapKey, unwrapKey,
  wrapKeyWithBio, unwrapKeyWithBio,
  encryptData, decryptData, decryptLegacy, zeroize,
  PASSPHRASE_ITERATIONS, PIN_ITERATIONS
} from './crypto.js';

const DB_NAME = 'cykel';
const DB_VERSION = 1;
const STORE_NAME = 'vault';

// Keys in the vault store
const K_DATA = 'app_data';
const K_PASS_WRAPPED = 'passphrase_wrapped';
const K_PIN_WRAPPED = 'pin_wrapped';
const K_BIO_WRAPPED = 'bio_wrapped';
const K_BIO_CREDENTIAL = 'bio_credential';
const K_FORMAT = 'format_version';

// Current format version
const FORMAT_V2 = 2;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Check if any data exists.
 */
export async function dataExists() {
  const db = await openDB();
  const data = await dbGet(db, K_DATA);
  db.close();
  return data != null;
}

/**
 * Check if PIN is configured.
 */
export async function hasPin() {
  const db = await openDB();
  const data = await dbGet(db, K_PIN_WRAPPED);
  db.close();
  return data != null;
}

/**
 * First-time setup with passphrase.
 * Returns { masterKeyBytes, data } — caller holds masterKeyBytes while unlocked.
 */
export async function setup(passphrase) {
  const masterKeyBytes = generateMasterKey();

  try {
    const defaultData = {
      cycles: [], day_logs: [], symptoms: [],
      settings: { auto_lock_minutes: 5, show_fertility: false },
    };

    const wrapped = await wrapKey(masterKeyBytes, passphrase, PASSPHRASE_ITERATIONS);
    const json = new TextEncoder().encode(JSON.stringify(defaultData));
    const encData = await encryptData(masterKeyBytes, json);

    const db = await openDB();
    await dbPut(db, K_PASS_WRAPPED, wrapped);
    await dbPut(db, K_DATA, encData);
    await dbPut(db, K_FORMAT, FORMAT_V2);
    db.close();

    return { masterKeyBytes, data: defaultData };
  } catch (e) {
    zeroize(masterKeyBytes);
    throw e;
  }
}

/**
 * Unlock with passphrase.
 * Handles migration from legacy v1 format.
 */
export async function unlockWithPassphrase(passphrase) {
  const db = await openDB();
  const version = await dbGet(db, K_FORMAT);
  const encData = await dbGet(db, K_DATA);

  if (!encData) {
    db.close();
    throw new Error('No data found');
  }

  // Legacy v1: data encrypted directly with passphrase-derived key
  if (!version || version < FORMAT_V2) {
    db.close();
    return migrateFromV1(passphrase, new Uint8Array(encData));
  }

  // v2: unwrap master key, then decrypt data
  const wrapped = await dbGet(db, K_PASS_WRAPPED);
  db.close();

  if (!wrapped) throw new Error('No data found');

  const masterKeyBytes = await unwrapKey(new Uint8Array(wrapped), passphrase, PASSPHRASE_ITERATIONS);
  const plaintext = await decryptData(masterKeyBytes, new Uint8Array(encData));
  const data = JSON.parse(new TextDecoder().decode(plaintext));

  return { masterKeyBytes, data };
}

/**
 * Unlock with PIN.
 */
export async function unlockWithPin(pin) {
  const db = await openDB();
  const wrapped = await dbGet(db, K_PIN_WRAPPED);
  const encData = await dbGet(db, K_DATA);
  db.close();

  if (!wrapped) throw new Error('PIN not set');
  if (!encData) throw new Error('No data found');

  const masterKeyBytes = await unwrapKey(new Uint8Array(wrapped), pin, PIN_ITERATIONS);
  const plaintext = await decryptData(masterKeyBytes, new Uint8Array(encData));
  const data = JSON.parse(new TextDecoder().decode(plaintext));

  return { masterKeyBytes, data };
}

/**
 * Save app data (encrypted with master key).
 */
export async function save(masterKeyBytes, appData) {
  const json = new TextEncoder().encode(JSON.stringify(appData));
  const encrypted = await encryptData(masterKeyBytes, json);
  const db = await openDB();
  await dbPut(db, K_DATA, encrypted);
  db.close();
}

/**
 * Set up a PIN for quick unlock.
 */
export async function setupPin(masterKeyBytes, pin) {
  const wrapped = await wrapKey(masterKeyBytes, pin, PIN_ITERATIONS);
  const db = await openDB();
  await dbPut(db, K_PIN_WRAPPED, wrapped);
  db.close();
}

/**
 * Remove PIN.
 */
export async function removePin() {
  const db = await openDB();
  await dbDelete(db, K_PIN_WRAPPED);
  db.close();
}

/**
 * Check if biometric is configured.
 */
export async function hasBio() {
  const db = await openDB();
  const data = await dbGet(db, K_BIO_CREDENTIAL);
  db.close();
  return data != null;
}

/**
 * Get stored biometric credential ID.
 */
export async function getBioCredentialId() {
  const db = await openDB();
  const data = await dbGet(db, K_BIO_CREDENTIAL);
  db.close();
  return data ? new Uint8Array(data) : null;
}

/**
 * Set up biometric unlock.
 */
export async function setupBio(masterKeyBytes, prfOutput, credentialId) {
  const wrapped = await wrapKeyWithBio(masterKeyBytes, prfOutput);
  const db = await openDB();
  await dbPut(db, K_BIO_WRAPPED, wrapped);
  await dbPut(db, K_BIO_CREDENTIAL, credentialId);
  db.close();
}

/**
 * Unlock with biometric PRF output.
 */
export async function unlockWithBio(prfOutput) {
  const db = await openDB();
  const wrapped = await dbGet(db, K_BIO_WRAPPED);
  const encData = await dbGet(db, K_DATA);
  db.close();

  if (!wrapped) throw new Error('Biometric not set');
  if (!encData) throw new Error('No data found');

  const masterKeyBytes = await unwrapKeyWithBio(new Uint8Array(wrapped), prfOutput);
  const plaintext = await decryptData(masterKeyBytes, new Uint8Array(encData));
  const data = JSON.parse(new TextDecoder().decode(plaintext));

  return { masterKeyBytes, data };
}

/**
 * Remove biometric.
 */
export async function removeBio() {
  const db = await openDB();
  await dbDelete(db, K_BIO_WRAPPED);
  await dbDelete(db, K_BIO_CREDENTIAL);
  db.close();
}

/**
 * Wipe all data.
 */
export async function wipe() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/**
 * Migrate from legacy v1 format to v2 master key format.
 */
async function migrateFromV1(passphrase, oldEncrypted) {
  const plaintext = await decryptLegacy(passphrase, oldEncrypted);
  const data = JSON.parse(new TextDecoder().decode(plaintext));

  // Re-encrypt with new master key architecture
  const masterKeyBytes = generateMasterKey();
  const wrapped = await wrapKey(masterKeyBytes, passphrase, PASSPHRASE_ITERATIONS);
  const json = new TextEncoder().encode(JSON.stringify(data));
  const encData = await encryptData(masterKeyBytes, json);

  const db = await openDB();
  await dbPut(db, K_PASS_WRAPPED, wrapped);
  await dbPut(db, K_DATA, encData);
  await dbPut(db, K_FORMAT, FORMAT_V2);
  db.close();

  return { masterKeyBytes, data };
}
