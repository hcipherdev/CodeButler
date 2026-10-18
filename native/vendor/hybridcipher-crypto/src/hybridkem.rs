//! `HybridKEM` combining `X25519` and `ML-KEM-768` with `HKDF` domain separation
//!
//! This module implements a hybrid Key Encapsulation Mechanism that combines:
//! - `X25519` (classical elliptic curve Diffie-Hellman) for immediate security
//! - `ML-KEM-768` (post-quantum lattice-based KEM) for quantum resistance
//! - `HKDF-SHA256` for secure key derivation with domain separation
//!
//! The hybrid approach ensures security against both classical and quantum adversaries.

use alloc::{format, vec::Vec};
use hkdf::Hkdf;
use rand_core::{CryptoRng, RngCore};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CryptoError, CryptoResult};
use crate::mlkem_adapter::{
    MlKemCiphertext, MlKemKeyPair, MlKemPublicKey, MlKemSecretKey, MlKemSharedSecret,
};
use crate::x25519::{X25519KeyPair, X25519PrivateKey, X25519PublicKey, X25519SharedSecret};

/// `HybridKEM` public key length: `X25519` (32) + `ML-KEM-768` (1184) = 1216 bytes
pub const HYBRID_PUBLIC_KEY_LEN: usize = 32 + 1184;

/// `HybridKEM` secret key length: `X25519` (32) + `ML-KEM-768` (2400) = 2432 bytes  
pub const HYBRID_SECRET_KEY_LEN: usize = 32 + 2400;

/// `HybridKEM` ciphertext length: `X25519` (32) + `ML-KEM-768` (1088) = 1120 bytes
pub const HYBRID_CIPHERTEXT_LEN: usize = 32 + 1088;

/// Derived shared secret length (256 bits)
pub const SHARED_SECRET_LEN: usize = 32;

/// Domain separation strings for `HKDF`
const DOMAIN_WELCOME: &[u8] = b"hybridkem-welcome";
const DOMAIN_GROUPUPDATE: &[u8] = b"hybridkem-groupupdate";
const DOMAIN_RECOVERY_WRITER_HANDOFF: &[u8] = b"hybridkem-recovery-writer-handoff-v1";

/// `HybridKEM` public key combining `X25519` and `ML-KEM-768`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HybridPublicKey {
    x25519_public: X25519PublicKey,
    mlkem_public: MlKemPublicKey,
}

/// `HybridKEM` secret key combining `X25519` and `ML-KEM-768`
#[derive(ZeroizeOnDrop)]
pub struct HybridSecretKey {
    x25519_private: X25519PrivateKey,
    mlkem_secret: MlKemSecretKey,
}

/// `HybridKEM` ciphertext combining `X25519` and `ML-KEM-768` ciphertexts
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HybridCiphertext {
    x25519_public: X25519PublicKey, // Ephemeral public key
    mlkem_ciphertext: MlKemCiphertext,
}

/// `HybridKEM` shared secret with zeroization
#[derive(ZeroizeOnDrop, Zeroize)]
pub struct SharedSecret {
    bytes: [u8; SHARED_SECRET_LEN],
}

/// `HybridKEM` key pair
pub struct HybridKeyPair {
    /// Public key
    pub public: HybridPublicKey,
    /// Secret key  
    pub secret: HybridSecretKey,
}

/// Context for HKDF domain separation
#[derive(Debug, Clone, Copy)]
pub enum Context {
    /// Welcome message encryption context
    Welcome,
    /// `GroupUpdate` message encryption context
    GroupUpdate,
    /// Recovery writer handoff encryption context
    RecoveryWriterHandoff,
}

impl Context {
    /// Get the domain separation string for this context
    #[must_use]
    const fn domain_string(self) -> &'static [u8] {
        match self {
            Self::Welcome => DOMAIN_WELCOME,
            Self::GroupUpdate => DOMAIN_GROUPUPDATE,
            Self::RecoveryWriterHandoff => DOMAIN_RECOVERY_WRITER_HANDOFF,
        }
    }
}

impl HybridPublicKey {
    /// Create a `HybridPublicKey` from bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the provided bytes do not form
    /// a valid hybrid public key.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != HYBRID_PUBLIC_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                HYBRID_PUBLIC_KEY_LEN,
                bytes.len()
            )));
        }

        // Split the bytes: first 32 bytes for X25519, remaining for ML-KEM
        let (x25519_bytes, mlkem_bytes) = bytes.split_at(32);

        let x25519_public = X25519PublicKey::from_bytes(x25519_bytes)?;
        let mlkem_public = MlKemPublicKey::from_bytes(mlkem_bytes)?;

        Ok(Self {
            x25519_public,
            mlkem_public,
        })
    }

    /// Convert `HybridPublicKey` to bytes
    #[must_use]
    pub fn to_bytes(&self) -> [u8; HYBRID_PUBLIC_KEY_LEN] {
        let mut bytes = [0u8; HYBRID_PUBLIC_KEY_LEN];

        // Copy X25519 public key (32 bytes)
        bytes[..32].copy_from_slice(self.x25519_public.as_bytes());

        // Copy ML-KEM public key (1184 bytes)
        bytes[32..].copy_from_slice(self.mlkem_public.as_bytes());

        bytes
    }

    /// Get `HybridPublicKey` as a byte vector
    #[must_use]
    pub fn as_bytes(&self) -> Vec<u8> {
        self.to_bytes().to_vec()
    }
}

impl HybridSecretKey {
    /// Create a `HybridSecretKey` from bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the provided bytes do not form
    /// a valid hybrid secret key.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != HYBRID_SECRET_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                HYBRID_SECRET_KEY_LEN,
                bytes.len()
            )));
        }

        // Split the bytes: first 32 bytes for X25519, remaining for ML-KEM
        let (x25519_bytes, mlkem_bytes) = bytes.split_at(32);

        let x25519_private = X25519PrivateKey::from_bytes(x25519_bytes)?;
        let mlkem_secret = MlKemSecretKey::from_bytes(mlkem_bytes)?;

        Ok(Self {
            x25519_private,
            mlkem_secret,
        })
    }

    /// Convert `HybridSecretKey` to bytes
    #[must_use]
    pub fn to_bytes(&self) -> [u8; HYBRID_SECRET_KEY_LEN] {
        let mut bytes = [0u8; HYBRID_SECRET_KEY_LEN];

        // Copy X25519 private key (32 bytes)
        bytes[..32].copy_from_slice(&self.x25519_private.to_bytes());

        // Copy ML-KEM secret key (2400 bytes)
        bytes[32..].copy_from_slice(self.mlkem_secret.as_bytes());

        bytes
    }
}

impl HybridCiphertext {
    /// Create `HybridCiphertext` from bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidCiphertext`] when the provided bytes do
    /// not form a valid hybrid ciphertext.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != HYBRID_CIPHERTEXT_LEN {
            return Err(CryptoError::InvalidCiphertext(format!(
                "Expected {} bytes, got {}",
                HYBRID_CIPHERTEXT_LEN,
                bytes.len()
            )));
        }

        // Split the bytes: first 32 bytes for X25519, remaining for ML-KEM
        let (x25519_bytes, mlkem_bytes) = bytes.split_at(32);

        let x25519_public = X25519PublicKey::from_bytes(x25519_bytes)?;
        let mlkem_ciphertext = MlKemCiphertext::from_bytes(mlkem_bytes)?;

        Ok(Self {
            x25519_public,
            mlkem_ciphertext,
        })
    }

    /// Convert `HybridCiphertext` to bytes
    #[must_use]
    pub fn to_bytes(&self) -> [u8; HYBRID_CIPHERTEXT_LEN] {
        let mut bytes = [0u8; HYBRID_CIPHERTEXT_LEN];

        // Copy X25519 ephemeral public key (32 bytes)
        bytes[..32].copy_from_slice(self.x25519_public.as_bytes());

        // Copy ML-KEM ciphertext (1088 bytes)
        bytes[32..].copy_from_slice(self.mlkem_ciphertext.as_bytes());

        bytes
    }

    /// Get `HybridCiphertext` as a byte vector
    #[must_use]
    pub fn as_bytes(&self) -> Vec<u8> {
        self.to_bytes().to_vec()
    }
}

impl SharedSecret {
    /// Get shared secret as byte slice
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Convert to array
    #[must_use]
    pub const fn to_array(&self) -> [u8; SHARED_SECRET_LEN] {
        self.bytes
    }
}

impl HybridKeyPair {
    /// Generate a new `HybridKEM` key pair
    ///
    /// # Errors
    /// Returns a [`CryptoError`] if ML-KEM key generation fails.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> CryptoResult<Self> {
        // Generate X25519 key pair
        let x25519_keypair = X25519KeyPair::generate(rng);

        // Generate ML-KEM key pair
        let mlkem_keypair = MlKemKeyPair::generate(rng)?;

        Ok(Self {
            public: HybridPublicKey {
                x25519_public: x25519_keypair.public,
                mlkem_public: mlkem_keypair.public,
            },
            secret: HybridSecretKey {
                x25519_private: x25519_keypair.private,
                mlkem_secret: mlkem_keypair.secret,
            },
        })
    }
}

/// Encapsulate a shared secret to a `HybridKEM` public key
///
/// # Errors
/// Returns a [`CryptoError`] if ML-KEM encapsulation or shared secret derivation fails.
pub fn encap<R: RngCore + CryptoRng>(
    pk_remote: &HybridPublicKey,
    context: Context,
    rng: &mut R,
) -> CryptoResult<(HybridCiphertext, SharedSecret)> {
    // Generate ephemeral X25519 key pair
    let x25519_ephemeral = X25519KeyPair::generate(rng);

    // Perform X25519 ECDH
    let x25519_shared = x25519_ephemeral
        .private
        .diffie_hellman(&pk_remote.x25519_public);

    // Perform ML-KEM encapsulation
    let (mlkem_ciphertext, mlkem_shared) = MlKemKeyPair::encapsulate(&pk_remote.mlkem_public, rng)?;

    // Combine the shared secrets using HKDF
    let combined_shared = derive_shared_secret(&x25519_shared, &mlkem_shared, context)?;

    let ciphertext = HybridCiphertext {
        x25519_public: x25519_ephemeral.public,
        mlkem_ciphertext,
    };

    Ok((ciphertext, combined_shared))
}

/// Decapsulate a shared secret from `HybridKEM` ciphertext
///
/// # Errors
/// Returns a [`CryptoError`] if ML-KEM decapsulation or shared secret derivation fails.
pub fn decap(
    sk_local: &HybridSecretKey,
    ct: &HybridCiphertext,
    context: Context,
) -> CryptoResult<SharedSecret> {
    // Perform X25519 ECDH with ephemeral public key
    let x25519_shared = sk_local.x25519_private.diffie_hellman(&ct.x25519_public);

    // Perform ML-KEM decapsulation
    let mlkem_shared = MlKemKeyPair::decapsulate(&sk_local.mlkem_secret, &ct.mlkem_ciphertext)?;

    // Combine the shared secrets using HKDF
    let combined_shared = derive_shared_secret(&x25519_shared, &mlkem_shared, context)?;

    Ok(combined_shared)
}

/// Derive the final shared secret using `HKDF-SHA256` with domain separation
fn derive_shared_secret(
    x25519_shared: &X25519SharedSecret,
    mlkem_shared: &MlKemSharedSecret,
    context: Context,
) -> CryptoResult<SharedSecret> {
    // Prepare input keying material: X25519 || ML-KEM
    let mut ikm = Vec::new();
    ikm.extend_from_slice(x25519_shared.as_bytes());
    ikm.extend_from_slice(mlkem_shared.as_bytes());

    // Extract and expand with domain separation
    let (_, hkdf_extract) = Hkdf::<Sha256>::extract(None, &ikm);

    let mut output = [0u8; SHARED_SECRET_LEN];
    hkdf_extract
        .expand(context.domain_string(), &mut output)
        .map_err(|_| CryptoError::KeyDerivationFailure("HKDF expansion failed".into()))?;

    Ok(SharedSecret { bytes: output })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use rand_core::OsRng;

    #[test]
    fn test_hybrid_key_generation() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        // Check key sizes
        assert_eq!(keypair.public.to_bytes().len(), HYBRID_PUBLIC_KEY_LEN);
        assert_eq!(keypair.secret.to_bytes().len(), HYBRID_SECRET_KEY_LEN);
    }

    #[test]
    fn test_hybrid_encap_decap_welcome() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        // Test encapsulation with Welcome context
        let (ciphertext, shared_secret1) =
            encap(&keypair.public, Context::Welcome, &mut rng).expect("Encapsulation failed");

        // Check ciphertext size
        assert_eq!(ciphertext.to_bytes().len(), HYBRID_CIPHERTEXT_LEN);
        assert_eq!(shared_secret1.as_bytes().len(), SHARED_SECRET_LEN);

        // Test decapsulation
        let shared_secret2 =
            decap(&keypair.secret, &ciphertext, Context::Welcome).expect("Decapsulation failed");

        // Shared secrets should match
        assert_eq!(shared_secret1.as_bytes(), shared_secret2.as_bytes());
    }

    #[test]
    fn test_hybrid_encap_decap_groupupdate() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        // Test encapsulation with GroupUpdate context
        let (ciphertext, shared_secret1) =
            encap(&keypair.public, Context::GroupUpdate, &mut rng).expect("Encapsulation failed");

        // Test decapsulation
        let shared_secret2 = decap(&keypair.secret, &ciphertext, Context::GroupUpdate)
            .expect("Decapsulation failed");

        // Shared secrets should match
        assert_eq!(shared_secret1.as_bytes(), shared_secret2.as_bytes());
    }

    #[test]
    fn test_domain_separation() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        // Encapsulate with Welcome context
        let (ciphertext, _) =
            encap(&keypair.public, Context::Welcome, &mut rng).expect("Encapsulation failed");

        // Decapsulate with both contexts
        let shared_secret_welcome =
            decap(&keypair.secret, &ciphertext, Context::Welcome).expect("Decapsulation failed");
        let shared_secret_groupupdate = decap(&keypair.secret, &ciphertext, Context::GroupUpdate)
            .expect("Decapsulation failed");

        // Different contexts should produce different shared secrets
        assert_ne!(
            shared_secret_welcome.as_bytes(),
            shared_secret_groupupdate.as_bytes()
        );
    }

    #[test]
    fn test_hybrid_public_key_serialization() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        let bytes = keypair.public.to_bytes();
        let recovered = HybridPublicKey::from_bytes(&bytes).expect("Deserialization failed");

        assert_eq!(keypair.public, recovered);
    }

    #[test]
    fn test_hybrid_secret_key_serialization() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        let bytes = keypair.secret.to_bytes();
        let recovered = HybridSecretKey::from_bytes(&bytes).expect("Deserialization failed");

        // Compare the serialized bytes since we can't directly compare secret keys
        assert_eq!(bytes, recovered.to_bytes());
    }

    #[test]
    fn test_hybrid_ciphertext_serialization() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        let (ciphertext, _) =
            encap(&keypair.public, Context::Welcome, &mut rng).expect("Encapsulation failed");

        let bytes = ciphertext.to_bytes();
        let recovered = HybridCiphertext::from_bytes(&bytes).expect("Deserialization failed");

        assert_eq!(ciphertext, recovered);
    }

    #[test]
    fn test_hybrid_invalid_key_sizes() {
        // Test invalid public key size
        let invalid_pub = vec![0u8; HYBRID_PUBLIC_KEY_LEN - 1];
        assert!(HybridPublicKey::from_bytes(&invalid_pub).is_err());

        // Test invalid secret key size
        let invalid_sec = vec![0u8; HYBRID_SECRET_KEY_LEN + 1];
        assert!(HybridSecretKey::from_bytes(&invalid_sec).is_err());

        // Test invalid ciphertext size
        let invalid_ct = vec![0u8; HYBRID_CIPHERTEXT_LEN / 2];
        assert!(HybridCiphertext::from_bytes(&invalid_ct).is_err());
    }

    #[test]
    fn test_hybrid_different_keypairs() {
        let mut rng = OsRng;
        let keypair1 = HybridKeyPair::generate(&mut rng).expect("Key generation failed");
        let keypair2 = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        let (ciphertext, _) =
            encap(&keypair1.public, Context::Welcome, &mut rng).expect("Encapsulation failed");

        // Decapsulating with wrong secret key should produce different shared secrets
        let shared_secret1 =
            decap(&keypair1.secret, &ciphertext, Context::Welcome).expect("Decapsulation failed");
        let shared_secret2 =
            decap(&keypair2.secret, &ciphertext, Context::Welcome).expect("Decapsulation failed");

        // Should be different secrets
        assert_ne!(shared_secret1.as_bytes(), shared_secret2.as_bytes());
    }

    #[test]
    fn test_hybrid_randomized_ciphertexts() {
        let mut rng = OsRng;
        let keypair = HybridKeyPair::generate(&mut rng).expect("Key generation failed");

        // Multiple encapsulations should produce different ciphertexts
        let (ct1, ss1) =
            encap(&keypair.public, Context::Welcome, &mut rng).expect("Encapsulation failed");
        let (ct2, ss2) =
            encap(&keypair.public, Context::Welcome, &mut rng).expect("Encapsulation failed");

        // Ciphertexts should be different (due to X25519 ephemeral key and ML-KEM randomness)
        assert_ne!(ct1.as_bytes(), ct2.as_bytes());

        // But both should decapsulate to valid shared secrets
        let ss1_decap =
            decap(&keypair.secret, &ct1, Context::Welcome).expect("Decapsulation failed");
        let ss2_decap =
            decap(&keypair.secret, &ct2, Context::Welcome).expect("Decapsulation failed");

        assert_eq!(ss1.as_bytes(), ss1_decap.as_bytes());
        assert_eq!(ss2.as_bytes(), ss2_decap.as_bytes());
    }
}
