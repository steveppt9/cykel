// ============================================
// Cykel PWA — Encrypted IndexedDB Storage
// ============================================

import { encrypt, decrypt, deriveKeyFromPassphrase } from './crypto.js';

const DB_NAME = 'cykel';
const DB_VERSION = 1;
const STORE_NAME = 'vault';
const DATA_KEY = 'app_data';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
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
 * Check if encrypted data exists in IndexedDB.
 */
export async function dataExists() {
  const db = await openDB();
  const data = await dbGet(db, DATA_KEY);
  db.close();
  return data != null;
}

/**
 * Save app data using a CryptoKey (not a passphrase).
 */
export async function save(cryptoKey, appData) {
  const json = new TextEncoder().encode(JSON.stringify(appData));
  const encrypted = await encrypt(cryptoKey, json);
  const db = await openDB();
  await dbPut(db, DATA_KEY, encrypted);
  db.close();
}

/**
 * Load app data: decrypt with passphrase, return { data, key }.
 * Caller holds the key for future saves, drops the passphrase.
 */
export async function load(passphrase) {
  const db = await openDB();
  const encrypted = await dbGet(db, DATA_KEY);
  db.close();

  if (!encrypted) {
    throw new Error('No data found');
  }

  const { plaintext, key } = await decrypt(passphrase, new Uint8Array(encrypted));
  const data = JSON.parse(new TextDecoder().decode(plaintext));
  return { data, key };
}

/**
 * Derive a fresh CryptoKey for first-time setup.
 */
export async function createKey(passphrase) {
  return deriveKeyFromPassphrase(passphrase);
}

/**
 * Wipe all data from IndexedDB.
 */
export async function wipe() {
  const db = await openDB();
  await dbDelete(db, DATA_KEY);
  db.close();
}
