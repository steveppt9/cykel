// ============================================
// Cykel PWA — Crypto Module v3
// Master key architecture: random AES key wrapped by passphrase, PIN, or biometric PRF
// ============================================

const SALT_LEN = 32;
const IV_LEN = 12;
const MAGIC = new TextEncoder().encode('CYKEL_V1');

export const PASSPHRASE_ITERATIONS = 600000;
export const PIN_ITERATIONS = 100000;
const BIO_HKDF_INFO = new TextEncoder().encode('cykel-bio-key-v1');

/**
 * Generate a random 256-bit master key.
 */
export function generateMasterKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Zero out a Uint8Array. Unlike JS strings, typed arrays CAN be scrubbed.
 */
export function zeroize(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

/**
 * Derive a wrapping key from a secret (passphrase or PIN) + salt via PBKDF2.
 */
async function deriveWrappingKey(secret, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Import raw master key bytes into a non-extractable CryptoKey for data encryption.
 */
async function importDataKey(masterKeyBytes) {
  return crypto.subtle.importKey(
    'raw',
    masterKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wrap (encrypt) master key bytes with a secret.
 * Returns: Uint8Array of salt(32) || iv(12) || ciphertext
 */
export async function wrapKey(masterKeyBytes, secret, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const wrappingKey = await deriveWrappingKey(secret, salt, iterations);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    masterKeyBytes
  );

  const result = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LEN);
  result.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return result;
}

/**
 * Unwrap (decrypt) master key bytes from a wrapped blob.
 * Returns: Uint8Array(32) master key bytes
 */
export async function unwrapKey(wrapped, secret, iterations) {
  const salt = wrapped.slice(0, SALT_LEN);
  const iv = wrapped.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = wrapped.slice(SALT_LEN + IV_LEN);
  const wrappingKey = await deriveWrappingKey(secret, salt, iterations);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      ciphertext
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new Error('Wrong passphrase');
  }
}

/**
 * Encrypt data with master key bytes.
 * Returns: Uint8Array of iv(12) || ciphertext (magic bytes inside ciphertext)
 */
export async function encryptData(masterKeyBytes, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await importDataKey(masterKeyBytes);

  const payload = new Uint8Array(MAGIC.length + plaintext.length);
  payload.set(MAGIC, 0);
  payload.set(plaintext, MAGIC.length);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payload
  );

  const result = new Uint8Array(IV_LEN + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LEN);
  return result;
}

/**
 * Decrypt data with master key bytes.
 * Returns: Uint8Array plaintext
 */
export async function decryptData(masterKeyBytes, encrypted) {
  const iv = encrypted.slice(0, IV_LEN);
  const ciphertext = encrypted.slice(IV_LEN);
  const key = await importDataKey(masterKeyBytes);

  let decrypted;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    );
  } catch {
    throw new Error('Decryption failed');
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (decrypted[i] !== MAGIC[i]) {
      throw new Error('Invalid data');
    }
  }

  return decrypted.slice(MAGIC.length);
}

/**
 * Wrap master key using high-entropy PRF output (biometric).
 * Uses HKDF instead of PBKDF2 since PRF output is already high-entropy.
 * Returns: Uint8Array of salt(32) || iv(12) || ciphertext
 */
export async function wrapKeyWithBio(masterKeyBytes, prfOutput) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));

  const keyMaterial = await crypto.subtle.importKey(
    'raw', prfOutput, 'HKDF', false, ['deriveKey']
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt, hash: 'SHA-256', info: BIO_HKDF_INFO },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, wrappingKey, masterKeyBytes
  );

  const result = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LEN);
  result.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return result;
}

/**
 * Unwrap master key using PRF output (biometric).
 * Returns: Uint8Array(32) master key bytes
 */
export async function unwrapKeyWithBio(wrapped, prfOutput) {
  const salt = wrapped.slice(0, SALT_LEN);
  const iv = wrapped.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = wrapped.slice(SALT_LEN + IV_LEN);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', prfOutput, 'HKDF', false, ['deriveKey']
  );
  const wrappingKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', salt, hash: 'SHA-256', info: BIO_HKDF_INFO },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, wrappingKey, ciphertext
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new Error('Biometric unlock failed');
  }
}

const EXPORT_MAGIC = new TextEncoder().encode('CYKEL_BACKUP_V1');

/**
 * Encrypt an exportable backup with a user-chosen passphrase (PBKDF2 + AES-GCM).
 * Returns: Uint8Array of salt(32) || iv(12) || ciphertext (magic inside ciphertext).
 */
export async function encryptExport(passphrase, plaintext) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveWrappingKey(passphrase, salt, PASSPHRASE_ITERATIONS);

  const payload = new Uint8Array(EXPORT_MAGIC.length + plaintext.length);
  payload.set(EXPORT_MAGIC, 0);
  payload.set(plaintext, EXPORT_MAGIC.length);

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload);

  const result = new Uint8Array(SALT_LEN + IV_LEN + ciphertext.byteLength);
  result.set(salt, 0);
  result.set(iv, SALT_LEN);
  result.set(new Uint8Array(ciphertext), SALT_LEN + IV_LEN);
  return result;
}

/**
 * Decrypt a backup produced by encryptExport.
 * Returns: Uint8Array plaintext. Throws on wrong passphrase or wrong file type.
 */
export async function decryptExport(passphrase, data) {
  const salt = data.slice(0, SALT_LEN);
  const iv = data.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = data.slice(SALT_LEN + IV_LEN);
  const key = await deriveWrappingKey(passphrase, salt, PASSPHRASE_ITERATIONS);

  let decrypted;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    );
  } catch {
    throw new Error('Wrong passphrase or corrupted file');
  }

  for (let i = 0; i < EXPORT_MAGIC.length; i++) {
    if (decrypted[i] !== EXPORT_MAGIC[i]) {
      throw new Error('Not a valid Cykel backup');
    }
  }

  return decrypted.slice(EXPORT_MAGIC.length);
}

/**
 * Legacy v1 decrypt: passphrase derives key directly from salt in blob.
 * Used only for migration from old format.
 * Returns: Uint8Array plaintext
 */
export async function decryptLegacy(passphrase, encrypted) {
  const salt = encrypted.slice(0, SALT_LEN);
  const iv = encrypted.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ciphertext = encrypted.slice(SALT_LEN + IV_LEN);

  const key = await deriveWrappingKey(passphrase, salt, PASSPHRASE_ITERATIONS);

  let decrypted;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    );
  } catch {
    throw new Error('Wrong passphrase');
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (decrypted[i] !== MAGIC[i]) {
      throw new Error('Wrong passphrase');
    }
  }

  return decrypted.slice(MAGIC.length);
}
