//! HKDF-SHA256 key derivation function with comprehensive domain separation
//!
//! This module provides a secure wrapper around HKDF-SHA256 for the HybridCipher system.
//! HKDF provides cryptographically strong key derivation with proper domain separation,
//! ensuring keys derived for different purposes are cryptographically independent.

use alloc::{format, vec, vec::Vec};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

use crate::error::{CryptoError, CryptoResult};

/// Maximum output length for HKDF (RFC 5869 limit: 255 * `HashLen`)
pub const HKDF_MAX_OUTPUT_LEN: usize = 255 * 32; // 255 * SHA256 hash length

/// Standard derived key length (32 bytes for 256-bit keys)
pub const DERIVED_KEY_LEN: usize = 32;

/// Domain separation contexts for different key derivation purposes
#[allow(clippy::enum_variant_names)]
#[derive(Debug, Clone, Copy)]
pub enum HkdfContext {
    /// Epoch key derivation for group rekeying
    EpochKey,
    /// File encryption key derivation
    FileKey,
    /// Message encryption key derivation
    MessageKey,
    /// Message authentication key derivation
    AuthKey,
    /// Welcome message key derivation
    WelcomeKey,
    /// `GroupUpdate` message key derivation
    GroupUpdateKey,
    /// Key-encrypting key derivation for wrapped DEKs
    KeyWrapping,
}

impl HkdfContext {
    /// Get the domain separation info string for this context
    const fn info_string(self) -> &'static [u8] {
        match self {
            Self::EpochKey => b"epoch-key-v1",
            Self::FileKey => b"file-key-v1",
            Self::MessageKey => b"message-key-v1",
            Self::AuthKey => b"auth-key-v1",
            Self::WelcomeKey => b"welcome-key-v1",
            Self::GroupUpdateKey => b"groupupdate-key-v1",
            Self::KeyWrapping => b"kek-wrap-v1",
        }
    }
}

/// Extract a pseudorandom key from input keying material using HKDF-Extract
#[must_use]
pub fn hkdf_extract(salt: Option<&[u8]>, ikm: &[u8]) -> Vec<u8> {
    let (prk, _) = Hkdf::<Sha256>::extract(salt, ikm);
    prk.to_vec()
}

/// Expand a pseudorandom key into output keying material using HKDF-Expand
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if the expansion fails or length is invalid
pub fn hkdf_expand(prk: &[u8], context: HkdfContext, length: usize) -> CryptoResult<Vec<u8>> {
    if length == 0 || length > HKDF_MAX_OUTPUT_LEN {
        return Err(CryptoError::KeyDerivationFailure(format!(
            "Invalid output length: {length} (max: {HKDF_MAX_OUTPUT_LEN})"
        )));
    }

    let hkdf = Hkdf::<Sha256>::from_prk(prk)
        .map_err(|e| CryptoError::KeyDerivationFailure(format!("Invalid PRK: {e}")))?;

    let mut output = vec![0u8; length];
    hkdf.expand(context.info_string(), &mut output)
        .map_err(|e| CryptoError::KeyDerivationFailure(format!("HKDF expansion failed: {e}")))?;

    Ok(output)
}

/// Expand with custom info string (for advanced use cases)
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if the expansion fails or length is invalid
pub fn hkdf_expand_with_info(prk: &[u8], info: &[u8], length: usize) -> CryptoResult<Vec<u8>> {
    if length == 0 || length > HKDF_MAX_OUTPUT_LEN {
        return Err(CryptoError::KeyDerivationFailure(format!(
            "Invalid output length: {length} (max: {HKDF_MAX_OUTPUT_LEN})"
        )));
    }

    let hkdf = Hkdf::<Sha256>::from_prk(prk)
        .map_err(|e| CryptoError::KeyDerivationFailure(format!("Invalid PRK: {e}")))?;

    let mut output = vec![0u8; length];
    hkdf.expand(info, &mut output)
        .map_err(|e| CryptoError::KeyDerivationFailure(format!("HKDF expansion failed: {e}")))?;

    Ok(output)
}

/// Perform complete HKDF (Extract + Expand) in one operation
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if the operation fails
pub fn hkdf_derive(
    salt: Option<&[u8]>,
    ikm: &[u8],
    context: HkdfContext,
    length: usize,
) -> CryptoResult<Vec<u8>> {
    if length == 0 || length > HKDF_MAX_OUTPUT_LEN {
        return Err(CryptoError::KeyDerivationFailure(format!(
            "Invalid output length: {length} (max: {HKDF_MAX_OUTPUT_LEN})"
        )));
    }

    let hkdf = Hkdf::<Sha256>::new(salt, ikm);
    let mut output = vec![0u8; length];

    hkdf.expand(context.info_string(), &mut output)
        .map_err(|e| CryptoError::KeyDerivationFailure(format!("HKDF derivation failed: {e}")))?;

    Ok(output)
}

/// Derive multiple related keys from the same input material
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if any derivation fails
pub fn hkdf_derive_multiple(
    salt: Option<&[u8]>,
    ikm: &[u8],
    contexts_and_lengths: &[(HkdfContext, usize)],
) -> CryptoResult<Vec<Vec<u8>>> {
    // Extract once
    let prk = hkdf_extract(salt, ikm);

    // Expand multiple times with different contexts
    let mut results = Vec::new();
    for &(context, length) in contexts_and_lengths {
        let key = hkdf_expand(&prk, context, length)?;
        results.push(key);
    }

    Ok(results)
}

/// Compute SHA-256 hash (utility function)
#[must_use]
pub fn sha256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

/// Derive a standard 32-byte key for a given context
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if the derivation fails
pub fn derive_key(
    salt: Option<&[u8]>,
    ikm: &[u8],
    context: HkdfContext,
) -> CryptoResult<[u8; DERIVED_KEY_LEN]> {
    let key_vec = hkdf_derive(salt, ikm, context, DERIVED_KEY_LEN)?;
    let mut key = [0u8; DERIVED_KEY_LEN];
    key.copy_from_slice(&key_vec);
    Ok(key)
}

/// Key stretching for password-based derivation with PBKDF2-like iteration
///
/// # Errors
/// Returns `CryptoError::KeyDerivationFailure` if the derivation fails
pub fn hkdf_stretch(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    context: HkdfContext,
    length: usize,
) -> CryptoResult<Vec<u8>> {
    if iterations == 0 {
        return Err(CryptoError::KeyDerivationFailure(
            "Iterations must be greater than 0".into(),
        ));
    }

    // Initial hash with salt
    let mut current = sha256(&[salt, password].concat());

    // Iterate hashing to slow down brute force attacks
    for _ in 1..iterations {
        current = sha256(&current);
    }

    // Final HKDF derivation
    hkdf_derive(Some(salt), &current, context, length)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    // Test vectors based on RFC 5869
    #[test]
    fn test_hkdf_basic_functionality() {
        // Test basic HKDF functionality without relying on external test vectors
        let ikm = b"input keying material";
        let salt = b"salt";
        let info = b"info";
        let length = 32;

        // Test extract
        let prk = hkdf_extract(Some(salt), ikm);
        assert_eq!(prk.len(), 32); // SHA-256 output length

        // Test expand
        let output = hkdf_expand_with_info(&prk, info, length).expect("Expand failed");
        assert_eq!(output.len(), length);

        // Test full HKDF (should match extract + expand)
        let hkdf_obj = Hkdf::<Sha256>::new(Some(salt), ikm);
        let mut expected = vec![0u8; length];
        hkdf_obj
            .expand(info, &mut expected)
            .expect("Reference HKDF failed");

        assert_eq!(output, expected);
    }

    #[test]
    fn test_hkdf_extract() {
        let ikm = b"input keying material";
        let salt = b"salt";

        let prk = hkdf_extract(Some(salt), ikm);
        assert_eq!(prk.len(), 32); // SHA-256 output length

        // Extract without salt
        let prk_no_salt = hkdf_extract(None, ikm);
        assert_eq!(prk_no_salt.len(), 32);

        // Should be different with and without salt
        assert_ne!(prk, prk_no_salt);
    }

    #[test]
    fn test_hkdf_expand() {
        let ikm = b"test input keying material";
        let prk = hkdf_extract(None, ikm);

        let output = hkdf_expand(&prk, HkdfContext::FileKey, 32).expect("Expand failed");
        assert_eq!(output.len(), 32);

        // Different contexts should produce different outputs
        let output2 = hkdf_expand(&prk, HkdfContext::MessageKey, 32).expect("Expand failed");
        assert_ne!(output, output2);
    }

    #[test]
    fn test_hkdf_derive() {
        let ikm = b"source material";
        let salt = b"random salt";

        let key = hkdf_derive(Some(salt), ikm, HkdfContext::EpochKey, 32).expect("Derive failed");
        assert_eq!(key.len(), 32);

        // Same inputs should produce same outputs
        let key2 = hkdf_derive(Some(salt), ikm, HkdfContext::EpochKey, 32).expect("Derive failed");
        assert_eq!(key, key2);

        // Different contexts should produce different outputs
        let key3 = hkdf_derive(Some(salt), ikm, HkdfContext::AuthKey, 32).expect("Derive failed");
        assert_ne!(key, key3);
    }

    #[test]
    fn test_hkdf_derive_multiple() {
        let ikm = b"shared input material";
        let salt = b"common salt";

        let requests = &[
            (HkdfContext::FileKey, 32),
            (HkdfContext::MessageKey, 16),
            (HkdfContext::AuthKey, 64),
        ];

        let keys =
            hkdf_derive_multiple(Some(salt), ikm, requests).expect("Multiple derivation failed");

        assert_eq!(keys.len(), 3);
        assert_eq!(keys[0].len(), 32);
        assert_eq!(keys[1].len(), 16);
        assert_eq!(keys[2].len(), 64);

        // All keys should be different
        assert_ne!(keys[0], keys[1][..].to_vec());
        assert_ne!(keys[0], keys[2][..32].to_vec());
        assert_ne!(keys[1], keys[2][..16].to_vec());
    }

    #[test]
    fn test_derive_key_convenience() {
        let ikm = b"test material";
        let salt = b"test salt";

        let key = derive_key(Some(salt), ikm, HkdfContext::WelcomeKey).expect("Derive key failed");
        assert_eq!(key.len(), DERIVED_KEY_LEN);

        // Test different contexts
        let key2 =
            derive_key(Some(salt), ikm, HkdfContext::GroupUpdateKey).expect("Derive key failed");
        assert_ne!(key, key2);
    }

    #[test]
    fn test_context_domain_separation() {
        let ikm = b"same input";
        let salt = b"same salt";

        let contexts = [
            HkdfContext::EpochKey,
            HkdfContext::FileKey,
            HkdfContext::MessageKey,
            HkdfContext::AuthKey,
            HkdfContext::WelcomeKey,
            HkdfContext::GroupUpdateKey,
            HkdfContext::KeyWrapping,
        ];

        let mut keys = Vec::new();
        for context in &contexts {
            let key = derive_key(Some(salt), ikm, *context).expect("Derive failed");
            keys.push(key);
        }

        // All keys should be different due to domain separation
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                assert_ne!(keys[i], keys[j], "Keys {i} and {j} should be different");
            }
        }
    }

    #[test]
    fn test_hkdf_stretch() {
        let password = b"weak password"; // lgtm[rust/hard-coded-cryptographic-value] non-secret deterministic test vector
        let salt = b"random salt for stretching"; // lgtm[rust/hard-coded-cryptographic-value] non-secret deterministic test vector

        let key1 =
            hkdf_stretch(password, salt, 1000, HkdfContext::FileKey, 32).expect("Stretch failed");
        assert_eq!(key1.len(), 32);

        let key2 =
            hkdf_stretch(password, salt, 2000, HkdfContext::FileKey, 32).expect("Stretch failed");
        assert_ne!(key1, key2); // Different iteration counts should produce different keys

        let key3 = hkdf_stretch(password, salt, 1000, HkdfContext::MessageKey, 32)
            .expect("Stretch failed");
        assert_ne!(key1, key3); // Different contexts should produce different keys
    }

    #[test]
    fn test_sha256_utility() {
        let data = b"test data";
        let hash = sha256(data);
        assert_eq!(hash.len(), 32);

        // Same input should produce same hash
        let hash2 = sha256(data);
        assert_eq!(hash, hash2);

        // Different input should produce different hash
        let hash3 = sha256(b"different data");
        assert_ne!(hash, hash3);
    }

    #[test]
    fn test_invalid_lengths() {
        let ikm = b"test";
        let prk = hkdf_extract(None, ikm);

        // Zero length should fail
        assert!(hkdf_expand(&prk, HkdfContext::FileKey, 0).is_err());

        // Too large length should fail
        assert!(hkdf_expand(&prk, HkdfContext::FileKey, HKDF_MAX_OUTPUT_LEN + 1).is_err());

        // Same for derive
        assert!(hkdf_derive(None, ikm, HkdfContext::FileKey, 0).is_err());
        assert!(hkdf_derive(None, ikm, HkdfContext::FileKey, HKDF_MAX_OUTPUT_LEN + 1).is_err());
    }

    #[test]
    fn test_invalid_prk() {
        // Too short PRK should fail
        let short_prk = vec![0u8; 16];
        assert!(hkdf_expand(&short_prk, HkdfContext::FileKey, 32).is_err());

        // Empty PRK should fail
        let empty_prk = vec![];
        assert!(hkdf_expand(&empty_prk, HkdfContext::FileKey, 32).is_err());
    }

    #[test]
    fn test_zero_iterations_stretch() {
        let password = b"password"; // lgtm[rust/hard-coded-cryptographic-value] non-secret deterministic test vector
        let salt = b"salt"; // lgtm[rust/hard-coded-cryptographic-value] non-secret deterministic test vector

        assert!(hkdf_stretch(password, salt, 0, HkdfContext::FileKey, 32).is_err());
    }

    #[test]
    fn test_maximum_output_length() {
        let ikm = b"test input";
        let prk = hkdf_extract(None, ikm);

        // Maximum allowed length should work
        let output = hkdf_expand(&prk, HkdfContext::FileKey, HKDF_MAX_OUTPUT_LEN)
            .expect("Max length expand failed");
        assert_eq!(output.len(), HKDF_MAX_OUTPUT_LEN);
    }

    #[test]
    fn test_empty_ikm() {
        let empty_ikm = b"";
        let salt = b"salt";

        // Empty IKM should still work (though not recommended)
        let key = hkdf_derive(Some(salt), empty_ikm, HkdfContext::FileKey, 32)
            .expect("Empty IKM should work");
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn test_large_ikm() {
        // Test with large input material
        let large_ikm = vec![42u8; 10000];
        let salt = b"salt";

        let key = hkdf_derive(Some(salt), &large_ikm, HkdfContext::FileKey, 32)
            .expect("Large IKM failed");
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn test_different_salt_lengths() {
        let ikm = b"input material";

        let key1 =
            hkdf_derive(Some(b"short"), ikm, HkdfContext::FileKey, 32).expect("Short salt failed");

        let long_salt = vec![0u8; 100];
        let key2 =
            hkdf_derive(Some(&long_salt), ikm, HkdfContext::FileKey, 32).expect("Long salt failed");

        let key3 = hkdf_derive(None, ikm, HkdfContext::FileKey, 32).expect("No salt failed");

        // All should be different
        assert_ne!(key1, key2);
        assert_ne!(key1, key3);
        assert_ne!(key2, key3);
    }
}
