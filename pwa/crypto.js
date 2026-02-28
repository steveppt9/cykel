// ============================================
// Cykel PWA — Crypto Module
// Web Crypto API: PBKDF2 + AES-256-GCM
// ============================================

const SALT_LEN = 32;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 600000;
const MAGIC = new TextEncoder().encode('CYKEL_V1');

/**
 * Derive a CryptoKey from a passphrase and salt using PBKDF2.
 */
async function deriveKey(passphrase, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext bytes with a passphrase.
 * Returns: Uint8Array of salt (32) || iv (12) || ciphertext
 */
export async function encrypt(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(passphrase, salt);

  // Prepend magic bytes
  const payload = new Uint8Array(MAGIC.length + plaintext.length);
  payload.set(MAGIC, 0);
  payload.set(plaintext, MAGIC.length);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payload
  );

  // Combine: salt || iv || ciphertext
  const result = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LEN);
  result.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return result;
}

/**
 * Decrypt data encrypted with encrypt().
 * Returns plaintext bytes, or throws on wrong passphrase.
 */
export async function decrypt(passphrase, encrypted) {
  if (encrypted.length < SALT_LEN + IV_LEN + MAGIC.length) {
    throw new Error('Invalid data format');
  }

  const salt = encrypted.slice(0, SALT_LEN);
  const iv = encrypted.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = encrypted.slice(SALT_LEN + IV_LEN);

  const key = await deriveKey(passphrase, salt);

  let decrypted;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    );
  } catch {
    throw new Error('Wrong passphrase');
  }

  // Verify magic bytes
  for (let i = 0; i < MAGIC.length; i++) {
    if (decrypted[i] !== MAGIC[i]) {
      throw new Error('Wrong passphrase');
    }
  }

  // Strip magic bytes
  return decrypted.slice(MAGIC.length);
}
