use std::fs;
use std::path::PathBuf;

use crate::crypto;
use crate::models::AppData;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("crypto error: {0}")]
    Crypto(#[from] crypto::CryptoError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("data directory not found")]
    NoDataDir,
}

/// Get the path to the encrypted data file.
fn data_file_path() -> Result<PathBuf, StorageError> {
    let dir = dirs::data_local_dir()
        .ok_or(StorageError::NoDataDir)?
        .join("cykel");
    fs::create_dir_all(&dir)?;
    Ok(dir.join("data.cykel"))
}

/// Check if a data file exists (i.e., app has been set up before).
pub fn data_exists() -> Result<bool, StorageError> {
    Ok(data_file_path()?.exists())
}

/// Save app data encrypted with the given passphrase.
pub fn save(passphrase: &str, data: &AppData) -> Result<(), StorageError> {
    let json = serde_json::to_vec(data)?;
    let encrypted = crypto::encrypt(passphrase, &json)?;
    let path = data_file_path()?;
    fs::write(path, encrypted)?;
    Ok(())
}

/// Load and decrypt app data with the given passphrase.
pub fn load(passphrase: &str) -> Result<AppData, StorageError> {
    let path = data_file_path()?;
    let encrypted = fs::read(path)?;
    let decrypted = crypto::decrypt(passphrase, &encrypted)?;
    let data: AppData = serde_json::from_slice(&decrypted)?;
    Ok(data)
}

/// Delete all data permanently.
pub fn wipe() -> Result<(), StorageError> {
    let path = data_file_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}
