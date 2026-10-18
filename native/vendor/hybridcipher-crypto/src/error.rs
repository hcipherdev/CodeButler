//! Error types for HybridCipher cryptographic operations

use alloc::string::String;

#[cfg(feature = "std")]
use thiserror::Error;

/// Cryptographic operation errors
#[cfg_attr(feature = "std", derive(Error))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    /// Invalid key format or size
    #[cfg_attr(feature = "std", error("Invalid key: {0}"))]
    InvalidKey(String),

    /// Invalid ciphertext format or authentication failure
    #[cfg_attr(feature = "std", error("Invalid ciphertext: {0}"))]
    InvalidCiphertext(String),

    /// Invalid signature
    #[cfg_attr(feature = "std", error("Invalid signature: {0}"))]
    InvalidSignature(String),

    /// Invalid nonce format or size
    #[cfg_attr(feature = "std", error("Invalid nonce: {0}"))]
    InvalidNonce(String),

    /// Encryption operation failure
    #[cfg_attr(feature = "std", error("Encryption failed: {0}"))]
    EncryptionFailure(String),

    /// Decryption operation failure
    #[cfg_attr(feature = "std", error("Decryption failed: {0}"))]
    DecryptionFailure(String),

    /// Random number generation failure
    #[cfg_attr(feature = "std", error("Random number generation failed: {0}"))]
    RandomFailure(String),

    /// Key derivation failure
    #[cfg_attr(feature = "std", error("Key derivation failed: {0}"))]
    KeyDerivationFailure(String),

    /// Internal cryptographic library error
    #[cfg_attr(feature = "std", error("Internal error: {0}"))]
    Internal(String),
}

#[cfg(not(feature = "std"))]
impl core::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::InvalidKey(msg) => write!(f, "Invalid key: {msg}"),
            Self::InvalidCiphertext(msg) => write!(f, "Invalid ciphertext: {msg}"),
            Self::InvalidSignature(msg) => write!(f, "Invalid signature: {msg}"),
            Self::InvalidNonce(msg) => write!(f, "Invalid nonce: {msg}"),
            Self::EncryptionFailure(msg) => write!(f, "Encryption failed: {msg}"),
            Self::DecryptionFailure(msg) => write!(f, "Decryption failed: {msg}"),
            Self::RandomFailure(msg) => write!(f, "Random number generation failed: {msg}"),
            Self::KeyDerivationFailure(msg) => write!(f, "Key derivation failed: {msg}"),
            Self::Internal(msg) => write!(f, "Internal error: {msg}"),
        }
    }
}

/// Result type for cryptographic operations
pub type CryptoResult<T> = Result<T, CryptoError>;
