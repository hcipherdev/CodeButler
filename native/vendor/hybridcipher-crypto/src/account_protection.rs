//! Account secret protection helpers built on ChaCha20-Poly1305.

use crate::error::{CryptoError, CryptoResult};
use alloc::{format, string::String, vec::Vec};
use base64::{engine::general_purpose, Engine as _};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

/// Identifier stored alongside protected blobs so we can detect the format.
pub const PROTECTED_DATA_MAGIC: &str = "hybridcipher-protected";
/// Current version of the protected data format.
pub const PROTECTED_DATA_VERSION: u8 = 1;

/// Envelope for password-protected data persisted on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtectedData {
    /// Format identifier used for parsing/migration checks.
    pub magic: String,
    /// Format version for backward compatibility.
    pub version: u8,
    /// Random nonce used for ChaCha20-Poly1305 (base64-encoded).
    pub nonce: String,
    /// Authenticated ciphertext payload (base64-encoded).
    pub ciphertext: String,
}

impl ProtectedData {
    /// Returns true when the envelope matches the format/version we support.
    #[must_use]
    pub fn is_supported(&self) -> bool {
        self.magic == PROTECTED_DATA_MAGIC && self.version == PROTECTED_DATA_VERSION
    }
}

/// Encrypt the provided plaintext with ChaCha20-Poly1305 using the supplied key and AAD.
///
/// The caller is responsible for securely deriving and storing the 32-byte key. The
/// additional authenticated data (AAD) is bound into the authentication tag to prevent
/// cross-context replay of ciphertexts (e.g. mixing session files with config files).
///
/// # Errors
/// Returns [`CryptoError::EncryptionFailure`] when the AEAD operation fails.
pub fn encrypt_with_ad(
    plaintext: &[u8],
    key_bytes: [u8; 32],
    aad: &[u8],
) -> CryptoResult<ProtectedData> {
    let key = Key::from_slice(&key_bytes);
    let cipher = ChaCha20Poly1305::new(key);

    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload = Payload {
        msg: plaintext,
        aad,
    };

    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|err| CryptoError::EncryptionFailure(format!("failed to encrypt data: {err}")))?;

    Ok(ProtectedData {
        magic: String::from(PROTECTED_DATA_MAGIC),
        version: PROTECTED_DATA_VERSION,
        nonce: general_purpose::STANDARD.encode(nonce_bytes),
        ciphertext: general_purpose::STANDARD.encode(ciphertext),
    })
}

/// Decrypt a previously protected blob using the same key and AAD that were provided
/// during encryption. Returns the plaintext bytes on success.
///
/// # Errors
/// Returns a [`CryptoError`] when the envelope metadata is unsupported, when the
/// base64 decoding of the nonce or ciphertext fails, or when AEAD verification
/// fails during decryption.
pub fn decrypt_with_ad(
    protected: &ProtectedData,
    key_bytes: [u8; 32],
    aad: &[u8],
) -> CryptoResult<Vec<u8>> {
    if !protected.is_supported() {
        return Err(CryptoError::InvalidCiphertext(format!(
            "unsupported protected blob format: magic='{}', version={}",
            protected.magic, protected.version
        )));
    }

    let key = Key::from_slice(&key_bytes);
    let cipher = ChaCha20Poly1305::new(key);

    let nonce_bytes = general_purpose::STANDARD
        .decode(&protected.nonce)
        .map_err(|err| {
            CryptoError::InvalidNonce(format!("failed to decode nonce (base64): {err}"))
        })?;
    if nonce_bytes.len() != 12 {
        return Err(CryptoError::InvalidNonce(format!(
            "expected 12 bytes, got {}",
            nonce_bytes.len()
        )));
    }
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext_bytes = general_purpose::STANDARD
        .decode(&protected.ciphertext)
        .map_err(|err| {
            CryptoError::InvalidCiphertext(format!("failed to decode ciphertext (base64): {err}"))
        })?;

    let payload = Payload {
        msg: &ciphertext_bytes,
        aad,
    };

    cipher
        .decrypt(nonce, payload)
        .map_err(|err| CryptoError::DecryptionFailure(format!("failed to decrypt data: {err}")))
}
