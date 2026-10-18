//! ChaCha20-Poly1305 authenticated encryption with associated data (AEAD)
//!
//! This module provides a secure wrapper around ChaCha20-Poly1305 AEAD for the HybridCipher system.
//! It includes proper nonce management, domain separation, and integration with the `HybridKEM`
//! shared secrets for complete authenticated encryption.

use alloc::{format, vec::Vec};
use chacha20poly1305::{
    aead::{Aead, KeyInit, OsRng},
    ChaCha20Poly1305, Key as ChaCha20Key, Nonce as ChaCha20Nonce,
};
use rand_core::{CryptoRng, RngCore};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CryptoError, CryptoResult};

/// ChaCha20-Poly1305 key length (32 bytes)
pub const AEAD_KEY_LEN: usize = 32;

/// ChaCha20-Poly1305 nonce length (12 bytes)
pub const AEAD_NONCE_LEN: usize = 12;

/// ChaCha20-Poly1305 authentication tag length (16 bytes)
pub const AEAD_TAG_LEN: usize = 16;

/// Domain separation strings for AAD prefixes
const DOMAIN_FILEDATA: &[u8] = b"filedata:";
const DOMAIN_WELCOME: &[u8] = b"welcome:";
const DOMAIN_GROUPUPDATE: &[u8] = b"groupupdate:";

/// ChaCha20-Poly1305 encryption key with zeroization
#[derive(ZeroizeOnDrop, Zeroize)]
pub struct Key {
    bytes: [u8; AEAD_KEY_LEN],
}

/// ChaCha20-Poly1305 nonce (96-bit)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nonce {
    bytes: [u8; AEAD_NONCE_LEN],
}

/// Domain context for AEAD operations with AAD prefixing
#[derive(Debug, Clone, Copy)]
pub enum AeadContext {
    /// File content encryption context
    FileData,
    /// Welcome message payload encryption
    Welcome,
    /// `GroupUpdate` message payload encryption
    GroupUpdate,
    /// Recovery writer handoff payload encryption
    RecoveryWriterHandoff,
}

impl AeadContext {
    /// Get the domain separation prefix for this context
    const fn domain_prefix(self) -> &'static [u8] {
        match self {
            Self::FileData => DOMAIN_FILEDATA,
            Self::Welcome => DOMAIN_WELCOME,
            Self::GroupUpdate => DOMAIN_GROUPUPDATE,
            Self::RecoveryWriterHandoff => b"recovery-writer-handoff:",
        }
    }
}

impl Key {
    /// Create a new AEAD key from bytes
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidKey` if the key length is incorrect
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != AEAD_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                AEAD_KEY_LEN,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; AEAD_KEY_LEN];
        key_bytes.copy_from_slice(bytes);

        Ok(Self { bytes: key_bytes })
    }

    /// Generate a random AEAD key
    ///
    /// # Errors
    /// Returns [`CryptoError::RandomFailure`] if randomness generation fails.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> CryptoResult<Self> {
        let mut key_bytes = [0u8; AEAD_KEY_LEN];
        rng.try_fill_bytes(&mut key_bytes)
            .map_err(|_| CryptoError::RandomFailure("Failed to generate AEAD key".into()))?;

        Ok(Self { bytes: key_bytes })
    }

    /// Convert key to bytes (use with caution)
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; AEAD_KEY_LEN] {
        self.bytes
    }

    /// Get key as byte slice
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl Nonce {
    /// Create a nonce from bytes
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidNonce` if the nonce length is incorrect
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != AEAD_NONCE_LEN {
            return Err(CryptoError::InvalidNonce(format!(
                "Expected {} bytes, got {}",
                AEAD_NONCE_LEN,
                bytes.len()
            )));
        }

        let mut nonce_bytes = [0u8; AEAD_NONCE_LEN];
        nonce_bytes.copy_from_slice(bytes);

        Ok(Self { bytes: nonce_bytes })
    }

    /// Generate a random nonce
    ///
    /// # Errors
    /// Returns [`CryptoError::RandomFailure`] if randomness generation fails.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> CryptoResult<Self> {
        let mut nonce_bytes = [0u8; AEAD_NONCE_LEN];
        rng.try_fill_bytes(&mut nonce_bytes)
            .map_err(|_| CryptoError::RandomFailure("Failed to generate nonce".into()))?;

        Ok(Self { bytes: nonce_bytes })
    }

    /// Generate a random nonce using OS randomness
    ///
    /// # Errors
    /// Returns [`CryptoError::RandomFailure`] if the operating system RNG fails.
    pub fn generate_os() -> CryptoResult<Self> {
        let mut nonce_bytes = [0u8; AEAD_NONCE_LEN];
        OsRng
            .try_fill_bytes(&mut nonce_bytes)
            .map_err(|_| CryptoError::RandomFailure("Failed to generate nonce from OS".into()))?;

        Ok(Self { bytes: nonce_bytes })
    }

    /// Convert nonce to bytes
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; AEAD_NONCE_LEN] {
        self.bytes
    }

    /// Get nonce as byte slice
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Encrypt plaintext with ChaCha20-Poly1305 AEAD
///
/// # Errors
/// Returns `CryptoError::EncryptionFailure` if encryption fails
pub fn seal(
    key: &Key,
    nonce: &Nonce,
    context: AeadContext,
    aad: &[u8],
    plaintext: &[u8],
) -> CryptoResult<Vec<u8>> {
    // Create ChaCha20Poly1305 cipher
    let cipher = ChaCha20Poly1305::new(ChaCha20Key::from_slice(key.as_bytes()));

    // Create nonce for ChaCha20Poly1305
    let chacha_nonce = ChaCha20Nonce::from_slice(nonce.as_bytes());

    // Prepare AAD with domain separation
    let mut domain_aad = Vec::new();
    domain_aad.extend_from_slice(context.domain_prefix());
    domain_aad.extend_from_slice(aad);

    // Encrypt with authentication
    cipher
        .encrypt(
            chacha_nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad: &domain_aad,
            },
        )
        .map_err(|_| CryptoError::EncryptionFailure("ChaCha20-Poly1305 encryption failed".into()))
}

/// Decrypt ciphertext with ChaCha20-Poly1305 AEAD
///
/// # Errors
/// Returns `CryptoError::DecryptionFailure` if decryption or authentication fails
pub fn open(
    key: &Key,
    nonce: &Nonce,
    context: AeadContext,
    aad: &[u8],
    ciphertext: &[u8],
) -> CryptoResult<Vec<u8>> {
    // Create ChaCha20Poly1305 cipher
    let cipher = ChaCha20Poly1305::new(ChaCha20Key::from_slice(key.as_bytes()));

    // Create nonce for ChaCha20Poly1305
    let chacha_nonce = ChaCha20Nonce::from_slice(nonce.as_bytes());

    // Prepare AAD with domain separation
    let mut domain_aad = Vec::new();
    domain_aad.extend_from_slice(context.domain_prefix());
    domain_aad.extend_from_slice(aad);

    // Decrypt and verify authentication
    cipher
        .decrypt(
            chacha_nonce,
            chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad: &domain_aad,
            },
        )
        .map_err(|_| CryptoError::DecryptionFailure("ChaCha20-Poly1305 decryption failed".into()))
}

/// Encrypt plaintext with additional authenticated data only (no domain separation)
///
/// # Errors
/// Returns `CryptoError::EncryptionFailure` if encryption fails
pub fn seal_with_aad(
    key: &Key,
    nonce: &Nonce,
    aad: &[u8],
    plaintext: &[u8],
) -> CryptoResult<Vec<u8>> {
    // Create ChaCha20Poly1305 cipher
    let cipher = ChaCha20Poly1305::new(ChaCha20Key::from_slice(key.as_bytes()));

    // Create nonce for ChaCha20Poly1305
    let chacha_nonce = ChaCha20Nonce::from_slice(nonce.as_bytes());

    // Encrypt with AAD
    cipher
        .encrypt(
            chacha_nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::EncryptionFailure("ChaCha20-Poly1305 encryption failed".into()))
}

/// Decrypt ciphertext with additional authenticated data only (no domain separation)
///
/// # Errors
/// Returns `CryptoError::DecryptionFailure` if decryption or authentication fails
pub fn open_with_aad(
    key: &Key,
    nonce: &Nonce,
    aad: &[u8],
    ciphertext: &[u8],
) -> CryptoResult<Vec<u8>> {
    // Create ChaCha20Poly1305 cipher
    let cipher = ChaCha20Poly1305::new(ChaCha20Key::from_slice(key.as_bytes()));

    // Create nonce for ChaCha20Poly1305
    let chacha_nonce = ChaCha20Nonce::from_slice(nonce.as_bytes());

    // Decrypt with AAD
    cipher
        .decrypt(
            chacha_nonce,
            chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::DecryptionFailure("ChaCha20-Poly1305 decryption failed".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use rand_core::OsRng;

    #[test]
    fn test_key_generation() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        assert_eq!(key.as_bytes().len(), AEAD_KEY_LEN);
    }

    #[test]
    fn test_key_serialization() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");

        let bytes = key.to_bytes();
        let recovered = Key::from_bytes(&bytes).expect("Key deserialization failed");

        assert_eq!(key.as_bytes(), recovered.as_bytes());
    }

    #[test]
    fn test_nonce_generation() {
        let mut rng = OsRng;
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");
        assert_eq!(nonce.as_bytes().len(), AEAD_NONCE_LEN);
    }

    #[test]
    fn test_nonce_os_generation() {
        let nonce = Nonce::generate_os().expect("OS nonce generation failed");
        assert_eq!(nonce.as_bytes().len(), AEAD_NONCE_LEN);
    }

    #[test]
    fn test_nonce_serialization() {
        let mut rng = OsRng;
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let bytes = nonce.to_bytes();
        let recovered = Nonce::from_bytes(&bytes).expect("Nonce deserialization failed");

        assert_eq!(nonce.as_bytes(), recovered.as_bytes());
    }

    #[test]
    fn test_aead_encrypt_decrypt_filedata() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"Hello, World! This is a test message.";
        let aad = b"additional authenticated data";

        // Encrypt
        let ciphertext =
            seal(&key, &nonce, AeadContext::FileData, aad, plaintext).expect("Encryption failed");

        // Verify ciphertext is different from plaintext
        assert_ne!(ciphertext.as_slice(), plaintext);
        assert_eq!(ciphertext.len(), plaintext.len() + AEAD_TAG_LEN);

        // Decrypt
        let decrypted =
            open(&key, &nonce, AeadContext::FileData, aad, &ciphertext).expect("Decryption failed");

        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_aead_encrypt_decrypt_welcome() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"Welcome message payload";
        let aad = b"message metadata";

        // Encrypt
        let ciphertext =
            seal(&key, &nonce, AeadContext::Welcome, aad, plaintext).expect("Encryption failed");

        // Decrypt
        let decrypted =
            open(&key, &nonce, AeadContext::Welcome, aad, &ciphertext).expect("Decryption failed");

        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_aead_encrypt_decrypt_groupupdate() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"GroupUpdate message payload";
        let aad = b"group metadata";

        // Encrypt
        let ciphertext = seal(&key, &nonce, AeadContext::GroupUpdate, aad, plaintext)
            .expect("Encryption failed");

        // Decrypt
        let decrypted = open(&key, &nonce, AeadContext::GroupUpdate, aad, &ciphertext)
            .expect("Decryption failed");

        assert_eq!(decrypted.as_slice(), plaintext);
    }

    #[test]
    fn test_aead_domain_separation() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"Same message";
        let aad = b"same aad";

        // Encrypt with different contexts
        let ct_filedata = seal(&key, &nonce, AeadContext::FileData, aad, plaintext)
            .expect("FileData encryption failed");
        let ct_welcome = seal(&key, &nonce, AeadContext::Welcome, aad, plaintext)
            .expect("Welcome encryption failed");

        // Ciphertexts should be different due to domain separation
        assert_ne!(ct_filedata, ct_welcome);

        // Cross-context decryption should fail
        assert!(open(&key, &nonce, AeadContext::Welcome, aad, &ct_filedata).is_err());
        assert!(open(&key, &nonce, AeadContext::FileData, aad, &ct_welcome).is_err());
    }

    #[test]
    fn test_aead_authentication_failure() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"Secret message";
        let aad = b"metadata";

        let ciphertext =
            seal(&key, &nonce, AeadContext::FileData, aad, plaintext).expect("Encryption failed");

        // Tamper with ciphertext
        let mut tampered = ciphertext.clone();
        tampered[0] ^= 1;

        // Decryption should fail
        assert!(open(&key, &nonce, AeadContext::FileData, aad, &tampered).is_err());

        // Wrong AAD should fail
        let wrong_aad = b"wrong metadata";
        assert!(open(&key, &nonce, AeadContext::FileData, wrong_aad, &ciphertext).is_err());

        // Wrong nonce should fail
        let wrong_nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");
        assert!(open(&key, &wrong_nonce, AeadContext::FileData, aad, &ciphertext).is_err());
    }

    #[test]
    fn test_aead_with_aad_functions() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"Test message for AAD functions";
        let aad = b"additional data";

        // Encrypt with AAD
        let ciphertext =
            seal_with_aad(&key, &nonce, aad, plaintext).expect("AAD encryption failed");

        // Decrypt with AAD
        let decrypted =
            open_with_aad(&key, &nonce, aad, &ciphertext).expect("AAD decryption failed");

        assert_eq!(decrypted.as_slice(), plaintext);

        // Wrong AAD should fail
        let wrong_aad = b"wrong aad";
        assert!(open_with_aad(&key, &nonce, wrong_aad, &ciphertext).is_err());
    }

    #[test]
    fn test_aead_empty_plaintext() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        let plaintext = b"";
        let aad = b"metadata for empty message";

        let ciphertext = seal(&key, &nonce, AeadContext::FileData, aad, plaintext)
            .expect("Empty encryption failed");

        let decrypted = open(&key, &nonce, AeadContext::FileData, aad, &ciphertext)
            .expect("Empty decryption failed");

        assert_eq!(decrypted.as_slice(), plaintext);
        assert_eq!(ciphertext.len(), AEAD_TAG_LEN); // Only authentication tag
    }

    #[test]
    fn test_aead_large_message() {
        let mut rng = OsRng;
        let key = Key::generate(&mut rng).expect("Key generation failed");
        let nonce = Nonce::generate(&mut rng).expect("Nonce generation failed");

        // Create a large message (1MB)
        let plaintext = vec![42u8; 1024 * 1024];
        let aad = b"large file metadata";

        let ciphertext = seal(&key, &nonce, AeadContext::FileData, aad, &plaintext)
            .expect("Large encryption failed");

        let decrypted = open(&key, &nonce, AeadContext::FileData, aad, &ciphertext)
            .expect("Large decryption failed");

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_invalid_key_size() {
        let invalid_key = vec![0u8; AEAD_KEY_LEN - 1];
        assert!(Key::from_bytes(&invalid_key).is_err());

        let oversized_key = vec![0u8; AEAD_KEY_LEN + 1];
        assert!(Key::from_bytes(&oversized_key).is_err());
    }

    #[test]
    fn test_invalid_nonce_size() {
        let invalid_nonce = vec![0u8; AEAD_NONCE_LEN - 1];
        assert!(Nonce::from_bytes(&invalid_nonce).is_err());

        let oversized_nonce = vec![0u8; AEAD_NONCE_LEN + 1];
        assert!(Nonce::from_bytes(&oversized_nonce).is_err());
    }
}
