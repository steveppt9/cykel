use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{self, Argon2, Params};
use rand::RngCore;
use zeroize::Zeroize;

const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Magic bytes prepended to plaintext before encryption.
/// On decrypt, we check for these to validate the passphrase.
const MAGIC: &[u8] = b"CYKEL_V1";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("key derivation failed")]
    KeyDerivation,
    #[error("encryption failed")]
    Encryption,
    #[error("decryption failed — wrong passphrase or corrupted data")]
    Decryption,
    #[error("invalid data format")]
    InvalidFormat,
}

/// Derive a 256-bit key from a passphrase and salt using Argon2id.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], CryptoError> {
    let params = Params::new(65536, 3, 1, Some(KEY_LEN)).map_err(|_| CryptoError::KeyDerivation)?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| CryptoError::KeyDerivation)?;

    Ok(key)
}

/// Encrypt plaintext data with a passphrase.
/// Returns: salt (32) || nonce (12) || ciphertext
pub fn encrypt(passphrase: &str, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);

    let mut key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::Encryption)?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Prepend magic bytes to plaintext for validation on decrypt
    let mut payload = Vec::with_capacity(MAGIC.len() + plaintext.len());
    payload.extend_from_slice(MAGIC);
    payload.extend_from_slice(plaintext);

    let ciphertext = cipher
        .encrypt(nonce, payload.as_slice())
        .map_err(|_| CryptoError::Encryption)?;

    // Zeroize sensitive material
    key.zeroize();
    payload.zeroize();

    // Output format: salt || nonce || ciphertext
    let mut output = Vec::with_capacity(SALT_LEN + NONCE_LEN + ciphertext.len());
    output.extend_from_slice(&salt);
    output.extend_from_slice(&nonce_bytes);
    output.extend_from_slice(&ciphertext);

    Ok(output)
}

/// Decrypt data that was encrypted with `encrypt`.
/// Returns the original plaintext, or an error if the passphrase is wrong.
pub fn decrypt(passphrase: &str, encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if encrypted.len() < SALT_LEN + NONCE_LEN + MAGIC.len() {
        return Err(CryptoError::InvalidFormat);
    }

    let salt = &encrypted[..SALT_LEN];
    let nonce_bytes = &encrypted[SALT_LEN..SALT_LEN + NONCE_LEN];
    let ciphertext = &encrypted[SALT_LEN + NONCE_LEN..];

    let mut key = derive_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::Decryption)?;
    let nonce = Nonce::from_slice(nonce_bytes);

    let mut decrypted = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::Decryption)?;

    key.zeroize();

    // Verify magic bytes
    if decrypted.len() < MAGIC.len() || &decrypted[..MAGIC.len()] != MAGIC {
        decrypted.zeroize();
        return Err(CryptoError::Decryption);
    }

    // Strip magic bytes
    let plaintext = decrypted[MAGIC.len()..].to_vec();
    decrypted.zeroize();

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let passphrase = "test-passphrase-123";
        let data = b"hello cykel";

        let encrypted = encrypt(passphrase, data).unwrap();
        let decrypted = decrypt(passphrase, &encrypted).unwrap();

        assert_eq!(decrypted, data);
    }

    #[test]
    fn wrong_passphrase_fails() {
        let data = b"secret data";
        let encrypted = encrypt("correct", data).unwrap();
        let result = decrypt("wrong", &encrypted);

        assert!(result.is_err());
    }

    #[test]
    fn corrupted_data_fails() {
        let result = decrypt("any", &[0u8; 10]);
        assert!(result.is_err());
    }
}
