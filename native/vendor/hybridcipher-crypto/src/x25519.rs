//! X25519 elliptic curve Diffie-Hellman implementation
//!
//! This module provides a secure wrapper around the x25519-dalek crate
//! with proper key management and zeroization.

use alloc::vec::Vec;
use rand_core::{CryptoRng, RngCore};
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CryptoError, CryptoResult};

/// X25519 public key length in bytes
pub const X25519_PUBLIC_KEY_LEN: usize = 32;

/// X25519 private key length in bytes  
pub const X25519_PRIVATE_KEY_LEN: usize = 32;

/// X25519 shared secret length in bytes
pub const X25519_SHARED_SECRET_LEN: usize = 32;

/// X25519 public key wrapper
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X25519PublicKey {
    inner: PublicKey,
}

/// X25519 private key wrapper with zeroization
#[derive(ZeroizeOnDrop)]
pub struct X25519PrivateKey {
    inner: StaticSecret,
}

/// X25519 key pair
pub struct X25519KeyPair {
    /// Public key
    pub public: X25519PublicKey,
    /// Private key
    pub private: X25519PrivateKey,
}

/// X25519 shared secret with zeroization
#[derive(ZeroizeOnDrop, Zeroize)]
pub struct X25519SharedSecret {
    bytes: [u8; X25519_SHARED_SECRET_LEN],
}

impl X25519PublicKey {
    /// Create a public key from bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the input length does not
    /// equal [`X25519_PUBLIC_KEY_LEN`].
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != X25519_PUBLIC_KEY_LEN {
            return Err(CryptoError::InvalidKey(alloc::format!(
                "Expected {} bytes, got {}",
                X25519_PUBLIC_KEY_LEN,
                bytes.len()
            )));
        }

        let mut array = [0u8; X25519_PUBLIC_KEY_LEN];
        array.copy_from_slice(bytes);

        Ok(Self {
            inner: PublicKey::from(array),
        })
    }

    /// Export public key as bytes
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; X25519_PUBLIC_KEY_LEN] {
        self.inner.as_bytes()
    }

    /// Export public key as Vec<u8>
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.as_bytes().to_vec()
    }
}

impl X25519PrivateKey {
    /// Create a private key from bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the input length does not
    /// equal [`X25519_PRIVATE_KEY_LEN`].
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != X25519_PRIVATE_KEY_LEN {
            return Err(CryptoError::InvalidKey(alloc::format!(
                "Expected {} bytes, got {}",
                X25519_PRIVATE_KEY_LEN,
                bytes.len()
            )));
        }

        let mut array = [0u8; X25519_PRIVATE_KEY_LEN];
        array.copy_from_slice(bytes);

        Ok(Self {
            inner: StaticSecret::from(array),
        })
    }

    /// Get the public key corresponding to this private key
    #[must_use]
    pub fn public_key(&self) -> X25519PublicKey {
        X25519PublicKey {
            inner: PublicKey::from(&self.inner),
        }
    }

    /// Perform X25519 ECDH with another public key
    #[must_use]
    pub fn diffie_hellman(&self, public: &X25519PublicKey) -> X25519SharedSecret {
        let shared = self.inner.diffie_hellman(&public.inner);
        X25519SharedSecret {
            bytes: *shared.as_bytes(),
        }
    }

    /// Export private key as bytes (use with caution)
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.inner.to_bytes().to_vec()
    }
}

impl X25519KeyPair {
    /// Generate a new X25519 key pair
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let private = X25519PrivateKey {
            inner: StaticSecret::random_from_rng(rng),
        };
        let public = private.public_key();

        Self { public, private }
    }

    /// Generate a new X25519 key pair using thread-local RNG
    #[cfg(feature = "std")]
    #[must_use]
    pub fn generate_with_thread_rng() -> Self {
        let private = X25519PrivateKey {
            inner: StaticSecret::random_from_rng(rand_core::OsRng),
        };
        let public = private.public_key();

        Self { public, private }
    }

    /// Create key pair from private key bytes
    ///
    /// # Errors
    /// Returns [`CryptoError::InvalidKey`] when the provided bytes are not the
    /// correct length for an X25519 private key.
    pub fn from_private_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        let private = X25519PrivateKey::from_bytes(bytes)?;
        let public = private.public_key();

        Ok(Self { public, private })
    }
}

impl X25519SharedSecret {
    /// Get the shared secret as bytes
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; X25519_SHARED_SECRET_LEN] {
        &self.bytes
    }

    /// Export shared secret as Vec<u8>
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        self.bytes.to_vec()
    }
}

impl core::fmt::Debug for X25519PrivateKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("X25519PrivateKey")
            .field("inner", &"<redacted>")
            .finish()
    }
}

impl core::fmt::Debug for X25519SharedSecret {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("X25519SharedSecret")
            .field("bytes", &"<redacted>")
            .finish()
    }
}

/// Perform ephemeral X25519 ECDH (generate key pair and do DH in one step)
#[must_use]
pub fn ephemeral_diffie_hellman<R: RngCore + CryptoRng>(
    rng: &mut R,
    public_key: &X25519PublicKey,
) -> (X25519PublicKey, X25519SharedSecret) {
    let ephemeral_secret = EphemeralSecret::random_from_rng(rng);
    let ephemeral_public = X25519PublicKey {
        inner: PublicKey::from(&ephemeral_secret),
    };

    let shared = ephemeral_secret.diffie_hellman(&public_key.inner);
    let shared_secret = X25519SharedSecret {
        bytes: *shared.as_bytes(),
    };

    (ephemeral_public, shared_secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    #[test]
    fn test_key_generation() {
        let keypair = X25519KeyPair::generate(&mut OsRng);

        // Test that public key can be serialized and deserialized
        let public_bytes = keypair.public.to_bytes();
        assert_eq!(public_bytes.len(), X25519_PUBLIC_KEY_LEN);

        let reconstructed_public = X25519PublicKey::from_bytes(&public_bytes).unwrap();
        assert_eq!(reconstructed_public, keypair.public);
    }

    #[test]
    fn test_diffie_hellman() {
        let alice_keypair = X25519KeyPair::generate(&mut OsRng);
        let bob_keypair = X25519KeyPair::generate(&mut OsRng);

        // Alice computes shared secret
        let alice_shared = alice_keypair.private.diffie_hellman(&bob_keypair.public);

        // Bob computes shared secret
        let bob_shared = bob_keypair.private.diffie_hellman(&alice_keypair.public);

        // Shared secrets should be equal
        assert_eq!(alice_shared.as_bytes(), bob_shared.as_bytes());
    }

    #[test]
    fn test_ephemeral_dh() {
        let static_keypair = X25519KeyPair::generate(&mut OsRng);

        let (ephemeral_public, ephemeral_shared) =
            ephemeral_diffie_hellman(&mut OsRng, &static_keypair.public);

        // Static party computes the same shared secret
        let static_shared = static_keypair.private.diffie_hellman(&ephemeral_public);

        assert_eq!(ephemeral_shared.as_bytes(), static_shared.as_bytes());
    }

    #[test]
    fn test_private_key_serialization() {
        let keypair = X25519KeyPair::generate(&mut OsRng);

        let private_bytes = keypair.private.to_bytes();
        assert_eq!(private_bytes.len(), X25519_PRIVATE_KEY_LEN);

        let reconstructed_keypair = X25519KeyPair::from_private_bytes(&private_bytes).unwrap();
        assert_eq!(reconstructed_keypair.public, keypair.public);
    }

    #[test]
    fn test_invalid_key_sizes() {
        // Test invalid public key size
        let invalid_public = X25519PublicKey::from_bytes(&[0u8; 31]);
        assert!(invalid_public.is_err());

        let invalid_public = X25519PublicKey::from_bytes(&[0u8; 33]);
        assert!(invalid_public.is_err());

        // Test invalid private key size
        let invalid_private = X25519PrivateKey::from_bytes(&[0u8; 31]);
        assert!(invalid_private.is_err());

        let invalid_private = X25519PrivateKey::from_bytes(&[0u8; 33]);
        assert!(invalid_private.is_err());
    }
}
