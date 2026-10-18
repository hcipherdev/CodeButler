//! HybridCipher Core Cryptographic Primitives
//!
//! This crate provides the fundamental cryptographic operations for the HybridCipher
//! secure file-sharing system. All operations are designed to be secure against
//! quantum attacks using hybrid classical + post-quantum cryptography.
//!
//! # Cryptographic Algorithm Assignments
//!
//! This implementation follows the algorithm assignments from the HybridCipher specification:
//!
//! - **Hybrid KEM**: X25519 + ML-KEM-768 combined with HKDF-SHA256
//! - **AEAD**: ChaCha20-Poly1305 for symmetric encryption
//! - **Signatures**: Ed25519 for digital signatures
//! - **KDF**: HKDF-SHA256 for key derivation
//! - **Hash**: SHA-256 for hashing operations
//!
//! # Security Guarantees
//!
//! - All secret key material is zeroized on drop
//! - No unsafe code except in `mlkem_adapter` module for ML-KEM integration
//! - Constant-time operations where cryptographically relevant
//! - Domain separation in key derivation functions

#![no_std]
#![deny(missing_docs)]
#![warn(clippy::all, clippy::pedantic, clippy::cargo, clippy::nursery)]
#![allow(clippy::multiple_crate_versions)]
// Allow unsafe code only for secure memory operations
#![cfg_attr(feature = "std", allow(unsafe_code))]

extern crate alloc;

#[cfg(feature = "std")]
extern crate std;

pub mod account_protection;
pub mod aead;
pub mod epoch_id;
pub mod error;
pub mod hybridkem;
pub mod kdf;
/// Shared account-key persistence, protected with user-scoped DPAPI on Windows.
#[cfg(feature = "std")]
pub mod local_key_cache;
pub mod rekey;
pub mod signatures;

/// Secure memory module (requires std feature)
#[cfg(feature = "std")]
pub mod secure_memory;

/// Secure deletion and memory protection
#[cfg(feature = "std")]
pub mod secure_delete;

// Private modules for implementation details
mod mlkem_adapter;
mod x25519;

// Re-export main types for convenience
pub use aead::{open, seal, AeadContext, Key as AeadKey, Nonce as AeadNonce};
pub use error::{CryptoError, CryptoResult};
pub use hybridkem::{
    decap, encap, Context, HybridCiphertext, HybridKeyPair, HybridPublicKey, HybridSecretKey,
    SharedSecret, HYBRID_CIPHERTEXT_LEN, HYBRID_PUBLIC_KEY_LEN, HYBRID_SECRET_KEY_LEN,
    SHARED_SECRET_LEN,
};
pub use kdf::{hkdf_expand, hkdf_extract, sha256};
pub use signatures::{Signature, SigningKey, VerifyingKey};

// Secure memory types (std feature only)
#[cfg(feature = "std")]
pub use secure_memory::{
    get_active_secret_count, global_memory_pool, KeyType, MemoryProtection, SecretBytes, SecretKey,
    SecureMemoryError, SecureMemoryPool, TimingSafeOperations,
};

// Secure deletion and memory protection (std feature only)
#[cfg(feature = "std")]
pub use secure_delete::{
    lock_memory, secure_zero, unlock_memory, LockedMemory, SecureDelete, SecurityError,
};

// Re-export for testing - may remove in production
pub use mlkem_adapter::{
    MlKemCiphertext, MlKemKeyPair, MlKemPublicKey, MlKemSecretKey, MlKemSharedSecret,
    MLKEM_CIPHERTEXT_LEN, MLKEM_PUBLIC_KEY_LEN, MLKEM_SECRET_KEY_LEN, MLKEM_SHARED_SECRET_LEN,
};
pub use x25519::{
    ephemeral_diffie_hellman, X25519KeyPair, X25519PrivateKey, X25519PublicKey, X25519SharedSecret,
};
