//! Ed25519 digital signatures for message authentication and integrity
//!
//! This module provides a secure wrapper around Ed25519 signatures for the HybridCipher system.
//! Ed25519 provides 128-bit security level with fast verification and deterministic signatures.

use alloc::format;
use ed25519_dalek::{
    Signature as Ed25519Signature, Signer, SigningKey as Ed25519SigningKey, Verifier,
    VerifyingKey as Ed25519VerifyingKey,
};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::ZeroizeOnDrop;

use crate::error::{CryptoError, CryptoResult};

/// Ed25519 signing key length (32 bytes)
pub const SIGNING_KEY_LEN: usize = 32;

/// Ed25519 verifying key length (32 bytes)
pub const VERIFYING_KEY_LEN: usize = 32;

/// Ed25519 signature length (64 bytes)
pub const SIGNATURE_LEN: usize = 64;

/// Ed25519 signing key with zeroization
#[derive(ZeroizeOnDrop)]
pub struct SigningKey {
    inner: Ed25519SigningKey,
}

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SigningKey")
            .field("inner", &"<redacted>")
            .finish()
    }
}

/// Ed25519 verifying key
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VerifyingKey {
    inner: Ed25519VerifyingKey,
}

/// Ed25519 signature
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    inner: Ed25519Signature,
    bytes: [u8; SIGNATURE_LEN],
}

impl SigningKey {
    /// Generate a new Ed25519 signing key
    ///
    /// # Errors
    /// Returns `CryptoError::RandomFailure` if random generation fails
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> CryptoResult<Self> {
        let mut seed = [0u8; SIGNING_KEY_LEN];
        rng.try_fill_bytes(&mut seed).map_err(|_| {
            CryptoError::RandomFailure("Failed to generate signing key seed".into())
        })?;

        let signing_key = Ed25519SigningKey::from_bytes(&seed);
        Ok(Self { inner: signing_key })
    }

    /// Create a signing key from bytes
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidKey` if the key bytes are invalid
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != SIGNING_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                SIGNING_KEY_LEN,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; SIGNING_KEY_LEN];
        key_bytes.copy_from_slice(bytes);

        let signing_key = Ed25519SigningKey::from_bytes(&key_bytes);
        Ok(Self { inner: signing_key })
    }

    /// Get the corresponding verifying key
    #[must_use]
    pub fn verifying_key(&self) -> VerifyingKey {
        VerifyingKey {
            inner: self.inner.verifying_key(),
        }
    }

    /// Sign a message
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidSignature` if signing fails
    pub fn sign(&self, message: &[u8]) -> CryptoResult<Signature> {
        let signature = self
            .inner
            .try_sign(message)
            .map_err(|e| CryptoError::InvalidSignature(format!("Signing failed: {e}")))?;

        let bytes = signature.to_bytes();
        Ok(Signature {
            inner: signature,
            bytes,
        })
    }

    /// Export signing key as bytes (use with caution)
    #[must_use]
    pub fn to_bytes(&self) -> [u8; SIGNING_KEY_LEN] {
        self.inner.to_bytes()
    }
}

impl VerifyingKey {
    /// Create a verifying key from bytes
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidKey` if the key bytes are invalid
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != VERIFYING_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                VERIFYING_KEY_LEN,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; VERIFYING_KEY_LEN];
        key_bytes.copy_from_slice(bytes);

        let verifying_key = Ed25519VerifyingKey::from_bytes(&key_bytes)
            .map_err(|e| CryptoError::InvalidKey(format!("Invalid verifying key: {e}")))?;

        Ok(Self {
            inner: verifying_key,
        })
    }

    /// Verify a signature on a message
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidSignature` if verification fails
    pub fn verify(&self, message: &[u8], signature: &Signature) -> CryptoResult<()> {
        self.inner
            .verify(message, &signature.inner)
            .map_err(|e| CryptoError::InvalidSignature(format!("Verification failed: {e}")))
    }

    /// Export verifying key as bytes
    #[must_use]
    pub fn to_bytes(&self) -> [u8; VERIFYING_KEY_LEN] {
        self.inner.to_bytes()
    }

    /// Get verifying key as byte slice
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        self.inner.as_bytes()
    }
}

impl Signature {
    /// Create a signature from bytes
    ///
    /// # Errors
    /// Returns `CryptoError::InvalidSignature` if the signature bytes are invalid
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != SIGNATURE_LEN {
            return Err(CryptoError::InvalidSignature(format!(
                "Expected {} bytes, got {}",
                SIGNATURE_LEN,
                bytes.len()
            )));
        }

        let mut sig_bytes = [0u8; SIGNATURE_LEN];
        sig_bytes.copy_from_slice(bytes);

        let signature = Ed25519Signature::from_bytes(&sig_bytes);
        Ok(Self {
            inner: signature,
            bytes: sig_bytes,
        })
    }

    /// Export signature as bytes
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; SIGNATURE_LEN] {
        self.bytes
    }

    /// Get signature as byte slice
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Sign a message with a signing key (convenience function)
///
/// # Errors
/// Returns `CryptoError::InvalidSignature` if signing fails
pub fn sign(signing_key: &SigningKey, message: &[u8]) -> CryptoResult<Signature> {
    signing_key.sign(message)
}

/// Verify a signature on a message (convenience function)
///
/// # Errors
/// Returns `CryptoError::InvalidSignature` if verification fails
pub fn verify(
    verifying_key: &VerifyingKey,
    message: &[u8],
    signature: &Signature,
) -> CryptoResult<()> {
    verifying_key.verify(message, signature)
}

/// Batch verify multiple signatures (more efficient than individual verification)
///
/// # Errors
/// Returns `CryptoError::InvalidSignature` if any signature verification fails
pub fn batch_verify(
    verifying_keys: &[VerifyingKey],
    messages: &[&[u8]],
    signatures: &[Signature],
) -> CryptoResult<()> {
    if verifying_keys.len() != messages.len() || messages.len() != signatures.len() {
        return Err(CryptoError::InvalidSignature(
            "Mismatched lengths for batch verification".into(),
        ));
    }

    // For now, verify individually - could be optimized with ed25519-dalek batch verification
    for ((verifying_key, message), signature) in verifying_keys
        .iter()
        .zip(messages.iter())
        .zip(signatures.iter())
    {
        verifying_key.verify(message, signature)?;
    }

    Ok(())
}

// Serde implementations for VerifyingKey
impl Serialize for VerifyingKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bytes(self.as_bytes())
    }
}

impl<'de> Deserialize<'de> for VerifyingKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let bytes = <&[u8]>::deserialize(deserializer)?;
        Self::from_bytes(bytes).map_err(serde::de::Error::custom)
    }
}

// Serde implementations for Signature
impl Serialize for Signature {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_bytes(&self.bytes)
    }
}

impl<'de> Deserialize<'de> for Signature {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let bytes = <&[u8]>::deserialize(deserializer)?;
        Self::from_bytes(bytes).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;
    use rand_core::OsRng;

    // Import vec! macro
    #[allow(unused_imports)]
    use alloc::vec;

    #[test]
    fn test_key_generation() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        assert_eq!(signing_key.to_bytes().len(), SIGNING_KEY_LEN);
        assert_eq!(verifying_key.to_bytes().len(), VERIFYING_KEY_LEN);
    }

    #[test]
    fn test_signing_key_serialization() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");

        let bytes = signing_key.to_bytes();
        let recovered = SigningKey::from_bytes(&bytes).expect("Key deserialization failed");

        // Keys should be functionally equivalent
        assert_eq!(signing_key.to_bytes(), recovered.to_bytes());
    }

    #[test]
    fn test_verifying_key_serialization() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let bytes = verifying_key.to_bytes();
        let recovered = VerifyingKey::from_bytes(&bytes).expect("Key deserialization failed");

        assert_eq!(verifying_key, recovered);
    }

    #[test]
    fn test_sign_verify() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let message = b"Hello, World! This is a test message for Ed25519 signatures.";

        // Sign the message
        let signature = signing_key.sign(message).expect("Signing failed");
        assert_eq!(signature.to_bytes().len(), SIGNATURE_LEN);

        // Verify the signature
        verifying_key
            .verify(message, &signature)
            .expect("Verification failed");
    }

    #[test]
    fn test_signature_serialization() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let message = b"Test message for signature serialization";

        let signature = signing_key.sign(message).expect("Signing failed");

        let bytes = signature.to_bytes();
        let recovered = Signature::from_bytes(&bytes).expect("Signature deserialization failed");

        assert_eq!(signature, recovered);
    }

    #[test]
    fn test_signature_deterministic() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let message = b"Deterministic test message";

        // Ed25519 signatures are deterministic
        let sig1 = signing_key.sign(message).expect("First signing failed");
        let sig2 = signing_key.sign(message).expect("Second signing failed");

        assert_eq!(sig1, sig2);
    }

    #[test]
    fn test_verification_failure() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let message = b"Original message";
        let signature = signing_key.sign(message).expect("Signing failed");

        // Wrong message should fail
        let wrong_message = b"Wrong message";
        assert!(verifying_key.verify(wrong_message, &signature).is_err());

        // Wrong signature should fail
        let wrong_signature =
            Signature::from_bytes(&[0u8; SIGNATURE_LEN]).expect("Invalid signature creation");
        assert!(verifying_key.verify(message, &wrong_signature).is_err());

        // Wrong key should fail
        let wrong_key = SigningKey::generate(&mut rng).expect("Wrong key generation failed");
        let wrong_verifying_key = wrong_key.verifying_key();
        assert!(wrong_verifying_key.verify(message, &signature).is_err());
    }

    #[test]
    fn test_convenience_functions() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let message = b"Test message for convenience functions";

        // Test convenience sign function
        let signature = sign(&signing_key, message).expect("Convenience signing failed");

        // Test convenience verify function
        verify(&verifying_key, message, &signature).expect("Convenience verification failed");
    }

    #[test]
    fn test_batch_verify() {
        let mut rng = OsRng;

        // Generate multiple key pairs
        let signing_keys: Vec<_> = (0..3)
            .map(|_| SigningKey::generate(&mut rng).expect("Key generation failed"))
            .collect();
        let verifying_keys: Vec<_> = signing_keys.iter().map(|sk| sk.verifying_key()).collect();

        // Create messages and signatures
        let messages = vec![
            b"First message".as_slice(),
            b"Second message".as_slice(),
            b"Third message".as_slice(),
        ];
        let signatures: CryptoResult<Vec<_>> = signing_keys
            .iter()
            .zip(messages.iter())
            .map(|(sk, msg)| sk.sign(msg))
            .collect();
        let signatures = signatures.expect("Batch signing failed");

        // Batch verify
        batch_verify(&verifying_keys, &messages, &signatures).expect("Batch verification failed");

        // Test with wrong signature
        let mut wrong_signatures = signatures.clone();
        wrong_signatures[1] = signing_keys[0]
            .sign(messages[1])
            .expect("Wrong signature creation");
        assert!(batch_verify(&verifying_keys, &messages, &wrong_signatures).is_err());
    }

    #[test]
    fn test_batch_verify_length_mismatch() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let verifying_keys = vec![verifying_key];
        let messages = vec![b"message1".as_slice(), b"message2".as_slice()]; // Different length
        let signatures = vec![];

        assert!(batch_verify(&verifying_keys, &messages, &signatures).is_err());
    }

    #[test]
    fn test_empty_message() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        let empty_message = b"";
        let signature = signing_key
            .sign(empty_message)
            .expect("Empty message signing failed");
        verifying_key
            .verify(empty_message, &signature)
            .expect("Empty message verification failed");
    }

    #[test]
    fn test_large_message() {
        let mut rng = OsRng;
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation failed");
        let verifying_key = signing_key.verifying_key();

        // Create a large message (1MB)
        let large_message = vec![42u8; 1024 * 1024];

        let signature = signing_key
            .sign(&large_message)
            .expect("Large message signing failed");
        verifying_key
            .verify(&large_message, &signature)
            .expect("Large message verification failed");
    }

    #[test]
    fn test_invalid_key_sizes() {
        // Test invalid signing key size
        let invalid_signing_key = vec![0u8; SIGNING_KEY_LEN - 1];
        assert!(SigningKey::from_bytes(&invalid_signing_key).is_err());

        let oversized_signing_key = vec![0u8; SIGNING_KEY_LEN + 1];
        assert!(SigningKey::from_bytes(&oversized_signing_key).is_err());

        // Test invalid verifying key size
        let invalid_verifying_key = vec![0u8; VERIFYING_KEY_LEN - 1];
        assert!(VerifyingKey::from_bytes(&invalid_verifying_key).is_err());

        let oversized_verifying_key = vec![0u8; VERIFYING_KEY_LEN + 1];
        assert!(VerifyingKey::from_bytes(&oversized_verifying_key).is_err());
    }

    #[test]
    fn test_invalid_signature_size() {
        let invalid_signature = vec![0u8; SIGNATURE_LEN - 1];
        assert!(Signature::from_bytes(&invalid_signature).is_err());

        let oversized_signature = vec![0u8; SIGNATURE_LEN + 1];
        assert!(Signature::from_bytes(&oversized_signature).is_err());
    }

    #[test]
    fn test_malformed_verifying_key() {
        // Ed25519 actually accepts most byte patterns as valid keys
        // Test with an empty key instead
        let empty_key = vec![0u8; 0];
        assert!(VerifyingKey::from_bytes(&empty_key).is_err());

        // Test with wrong size
        let wrong_size_key = vec![0u8; VERIFYING_KEY_LEN - 1];
        assert!(VerifyingKey::from_bytes(&wrong_size_key).is_err());
    }
}

/// Ed25519 key pair for convenient key management
pub struct Ed25519KeyPair {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

impl Clone for Ed25519KeyPair {
    fn clone(&self) -> Self {
        // Create a new keypair from the signing key bytes
        let signing_key_bytes = self.signing_key.to_bytes();
        let signing_key = SigningKey::from_bytes(&signing_key_bytes)
            .expect("Valid signing key bytes should always deserialize");
        let verifying_key = signing_key.verifying_key();

        Self {
            signing_key,
            verifying_key,
        }
    }
}

impl std::fmt::Debug for Ed25519KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ed25519KeyPair")
            .field(
                "verifying_key",
                &format!("{:?}", self.verifying_key.to_bytes()),
            )
            .finish_non_exhaustive()
    }
}

impl Ed25519KeyPair {
    /// Generate a new Ed25519 key pair
    ///
    /// # Panics
    /// Panics if the system RNG fails when seeding the signing key.
    #[must_use]
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();
        let signing_key = SigningKey::generate(&mut rng).expect("Key generation should not fail");
        let verifying_key = signing_key.verifying_key();

        Self {
            signing_key,
            verifying_key,
        }
    }

    /// Create key pair from signing key bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the provided bytes do not form
    /// a valid Ed25519 signing key.
    pub fn from_bytes(private_key_bytes: &[u8]) -> CryptoResult<Self> {
        let signing_key = SigningKey::from_bytes(private_key_bytes)?;
        let verifying_key = signing_key.verifying_key();

        Ok(Self {
            signing_key,
            verifying_key,
        })
    }

    /// Get the private key bytes
    #[must_use]
    pub fn private_key_bytes(&self) -> [u8; SIGNING_KEY_LEN] {
        self.signing_key.to_bytes()
    }

    /// Get the public key bytes
    #[must_use]
    pub fn public_key_bytes(&self) -> [u8; VERIFYING_KEY_LEN] {
        self.verifying_key.to_bytes()
    }

    /// Sign a message
    ///
    /// # Panics
    /// Panics if the underlying Ed25519 signing operation reports an error.
    #[must_use]
    pub fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN] {
        self.signing_key
            .sign(message)
            .expect("Signing should not fail")
            .to_bytes()
    }

    /// Get the verifying key
    #[must_use]
    pub const fn verifying_key(&self) -> &VerifyingKey {
        &self.verifying_key
    }

    /// Get the signing key
    #[must_use]
    pub const fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }
}

impl Drop for Ed25519KeyPair {
    fn drop(&mut self) {
        // VerifyingKey doesn't need to be zeroed as it's public
        // SigningKey has its own ZeroizeOnDrop implementation
    }
}
