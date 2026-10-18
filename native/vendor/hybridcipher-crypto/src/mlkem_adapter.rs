//! ML-KEM-768 adapter backed by aws-lc-rs
//!
//! This module provides a safe wrapper around the aws-lc ML-KEM (Kyber) 768-bit
//! implementation, exposing the same API as the previous placeholder but
//! backed by production-grade primitives.

use alloc::format;
use core::ptr::null_mut;
use rand_core::{CryptoRng, RngCore};
use zeroize::{Zeroize, ZeroizeOnDrop};

use aws_lc_sys::{
    EVP_PKEY_CTX_free, EVP_PKEY_CTX_kem_set_params, EVP_PKEY_CTX_new, EVP_PKEY_CTX_new_id,
    EVP_PKEY_decapsulate, EVP_PKEY_encapsulate, EVP_PKEY_free, EVP_PKEY_get_raw_private_key,
    EVP_PKEY_get_raw_public_key, EVP_PKEY_kem_new_raw_public_key, EVP_PKEY_kem_new_raw_secret_key,
    EVP_PKEY_keygen, EVP_PKEY_keygen_init, EVP_PKEY, EVP_PKEY_CTX, EVP_PKEY_KEM, NID_MLKEM768,
};

use crate::error::{CryptoError, CryptoResult};

/// ML-KEM-768 public key length in bytes (1184 bytes)
pub const MLKEM_PUBLIC_KEY_LEN: usize = 1184;

/// ML-KEM-768 secret key length in bytes (2400 bytes)  
pub const MLKEM_SECRET_KEY_LEN: usize = 2400;

/// ML-KEM-768 ciphertext length in bytes (1088 bytes)
pub const MLKEM_CIPHERTEXT_LEN: usize = 1088;

/// ML-KEM-768 shared secret length in bytes (32 bytes)
pub const MLKEM_SHARED_SECRET_LEN: usize = 32;

/// ML-KEM-768 public key wrapper
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlKemPublicKey {
    bytes: [u8; MLKEM_PUBLIC_KEY_LEN],
}

/// ML-KEM-768 secret key wrapper with zeroization
#[derive(ZeroizeOnDrop)]
pub struct MlKemSecretKey {
    bytes: [u8; MLKEM_SECRET_KEY_LEN],
}

/// ML-KEM-768 key pair
pub struct MlKemKeyPair {
    /// Public key
    pub public: MlKemPublicKey,
    /// Secret key
    pub secret: MlKemSecretKey,
}

/// ML-KEM-768 ciphertext wrapper
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MlKemCiphertext {
    bytes: [u8; MLKEM_CIPHERTEXT_LEN],
}

/// ML-KEM-768 shared secret with zeroization
#[derive(ZeroizeOnDrop, Zeroize)]
pub struct MlKemSharedSecret {
    bytes: [u8; MLKEM_SHARED_SECRET_LEN],
}

impl MlKemPublicKey {
    /// Construct an ML-KEM public key from raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != MLKEM_PUBLIC_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                MLKEM_PUBLIC_KEY_LEN,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; MLKEM_PUBLIC_KEY_LEN];
        key_bytes.copy_from_slice(bytes);
        Ok(Self { bytes: key_bytes })
    }

    /// Return the public key as a fixed-size byte array.
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; MLKEM_PUBLIC_KEY_LEN] {
        self.bytes
    }

    /// Borrow the public key as a byte slice.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl MlKemSecretKey {
    /// Construct an ML-KEM secret key from raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != MLKEM_SECRET_KEY_LEN {
            return Err(CryptoError::InvalidKey(format!(
                "Expected {} bytes, got {}",
                MLKEM_SECRET_KEY_LEN,
                bytes.len()
            )));
        }

        let mut key_bytes = [0u8; MLKEM_SECRET_KEY_LEN];
        key_bytes.copy_from_slice(bytes);
        Ok(Self { bytes: key_bytes })
    }

    /// Return the secret key as a fixed-size byte array.
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; MLKEM_SECRET_KEY_LEN] {
        self.bytes
    }

    /// Borrow the secret key bytes (internal use).
    #[must_use]
    pub(crate) const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl MlKemCiphertext {
    /// Construct an ML-KEM ciphertext from raw bytes.
    pub fn from_bytes(bytes: &[u8]) -> CryptoResult<Self> {
        if bytes.len() != MLKEM_CIPHERTEXT_LEN {
            return Err(CryptoError::InvalidCiphertext(format!(
                "Expected {} bytes, got {}",
                MLKEM_CIPHERTEXT_LEN,
                bytes.len()
            )));
        }

        let mut ct_bytes = [0u8; MLKEM_CIPHERTEXT_LEN];
        ct_bytes.copy_from_slice(bytes);
        Ok(Self { bytes: ct_bytes })
    }

    /// Return the ciphertext as a fixed-size byte array.
    #[must_use]
    pub const fn to_bytes(&self) -> [u8; MLKEM_CIPHERTEXT_LEN] {
        self.bytes
    }

    /// Borrow the ciphertext bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl MlKemSharedSecret {
    /// Borrow the shared secret bytes.
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl MlKemKeyPair {
    /// Generate a fresh ML-KEM-768 key pair using aws-lc.
    pub fn generate<R: RngCore + CryptoRng>(_rng: &mut R) -> CryptoResult<Self> {
        let (secret_bytes, public_bytes) = generate_keypair()?;
        Ok(Self {
            public: MlKemPublicKey {
                bytes: public_bytes,
            },
            secret: MlKemSecretKey {
                bytes: secret_bytes,
            },
        })
    }

    /// Encapsulate a shared secret to the provided ML-KEM public key.
    pub fn encapsulate<R: RngCore + CryptoRng>(
        public_key: &MlKemPublicKey,
        _rng: &mut R,
    ) -> CryptoResult<(MlKemCiphertext, MlKemSharedSecret)> {
        let (ciphertext, shared) = encapsulate_with_public(public_key.as_bytes())?;
        Ok((
            MlKemCiphertext { bytes: ciphertext },
            MlKemSharedSecret { bytes: shared },
        ))
    }

    /// Decapsulate a shared secret from the supplied ML-KEM ciphertext.
    pub fn decapsulate(
        secret_key: &MlKemSecretKey,
        ciphertext: &MlKemCiphertext,
    ) -> CryptoResult<MlKemSharedSecret> {
        let shared = decapsulate_with_secret(secret_key.as_bytes(), ciphertext.as_bytes())?;
        Ok(MlKemSharedSecret { bytes: shared })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use rand_core::OsRng;

    #[test]
    fn test_key_generation() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");
        assert_eq!(keypair.public.as_bytes().len(), MLKEM_PUBLIC_KEY_LEN);
        assert_eq!(keypair.secret.as_bytes().len(), MLKEM_SECRET_KEY_LEN);
    }

    #[test]
    fn test_placeholder_encap_decap() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");

        // Test encapsulation
        let (ciphertext, _shared_secret1) =
            MlKemKeyPair::encapsulate(&keypair.public, &mut rng).expect("Encapsulation failed");
        assert_eq!(ciphertext.as_bytes().len(), MLKEM_CIPHERTEXT_LEN);

        let shared_secret2 =
            MlKemKeyPair::decapsulate(&keypair.secret, &ciphertext).expect("Decapsulation failed");

        assert_eq!(shared_secret2.as_bytes().len(), MLKEM_SHARED_SECRET_LEN);
    }

    #[test]
    fn test_public_key_serialization() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");

        let bytes = keypair.public.to_bytes();
        let recovered = MlKemPublicKey::from_bytes(&bytes).expect("Deserialization failed");

        assert_eq!(keypair.public, recovered);
    }

    #[test]
    fn test_secret_key_serialization() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");

        let bytes = keypair.secret.to_bytes();
        let recovered = MlKemSecretKey::from_bytes(&bytes).expect("Deserialization failed");

        // Compare the bytes since we can't directly compare secret keys
        assert_eq!(keypair.secret.as_bytes(), recovered.as_bytes());
    }

    #[test]
    fn test_ciphertext_serialization() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");

        let (ciphertext, _) =
            MlKemKeyPair::encapsulate(&keypair.public, &mut rng).expect("Encapsulation failed");

        let bytes = ciphertext.to_bytes();
        let recovered = MlKemCiphertext::from_bytes(&bytes).expect("Deserialization failed");

        assert_eq!(ciphertext, recovered);
    }

    #[test]
    fn test_invalid_key_sizes() {
        // Test invalid public key size
        let invalid_pub = vec![0u8; MLKEM_PUBLIC_KEY_LEN - 1];
        assert!(MlKemPublicKey::from_bytes(&invalid_pub).is_err());

        // Test invalid secret key size
        let invalid_sec = vec![0u8; MLKEM_SECRET_KEY_LEN + 1];
        assert!(MlKemSecretKey::from_bytes(&invalid_sec).is_err());

        // Test invalid ciphertext size
        let invalid_ct = vec![0u8; MLKEM_CIPHERTEXT_LEN / 2];
        assert!(MlKemCiphertext::from_bytes(&invalid_ct).is_err());
    }

    #[test]
    fn test_decap_deterministic() {
        let mut rng = OsRng;
        let keypair = MlKemKeyPair::generate(&mut rng).expect("Key generation failed");

        let (ciphertext, _) =
            MlKemKeyPair::encapsulate(&keypair.public, &mut rng).expect("Encapsulation failed");

        let shared_secret1 =
            MlKemKeyPair::decapsulate(&keypair.secret, &ciphertext).expect("Decapsulation failed");
        let shared_secret2 =
            MlKemKeyPair::decapsulate(&keypair.secret, &ciphertext).expect("Decapsulation failed");

        assert_eq!(shared_secret1.as_bytes(), shared_secret2.as_bytes());
    }
}

/// RAII wrapper for `EVP_PKEY` pointers.
struct EvpPkey(*mut EVP_PKEY);

impl Drop for EvpPkey {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                EVP_PKEY_free(self.0);
            }
        }
    }
}

/// RAII wrapper for `EVP_PKEY_CTX` pointers.
struct EvpPkeyCtx(*mut EVP_PKEY_CTX);

impl Drop for EvpPkeyCtx {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                EVP_PKEY_CTX_free(self.0);
            }
        }
    }
}

fn map_internal_error(label: &str) -> CryptoError {
    CryptoError::Internal(format!("aws-lc ML-KEM failure: {label}"))
}

fn generate_keypair() -> CryptoResult<([u8; MLKEM_SECRET_KEY_LEN], [u8; MLKEM_PUBLIC_KEY_LEN])> {
    unsafe {
        let ctx_ptr = EVP_PKEY_CTX_new_id(EVP_PKEY_KEM, null_mut());
        if ctx_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_CTX_new_id"));
        }
        let ctx = EvpPkeyCtx(ctx_ptr);

        if EVP_PKEY_CTX_kem_set_params(ctx.0, NID_MLKEM768) != 1 {
            return Err(map_internal_error("EVP_PKEY_CTX_kem_set_params"));
        }

        if EVP_PKEY_keygen_init(ctx.0) != 1 {
            return Err(map_internal_error("EVP_PKEY_keygen_init"));
        }

        let mut pkey_ptr: *mut EVP_PKEY = null_mut();
        if EVP_PKEY_keygen(ctx.0, &mut pkey_ptr) != 1 || pkey_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_keygen"));
        }
        let pkey = EvpPkey(pkey_ptr);

        let mut public = [0u8; MLKEM_PUBLIC_KEY_LEN];
        let mut public_len = public.len();
        if EVP_PKEY_get_raw_public_key(pkey.0, public.as_mut_ptr(), &mut public_len) != 1
            || public_len != MLKEM_PUBLIC_KEY_LEN
        {
            return Err(map_internal_error("EVP_PKEY_get_raw_public_key"));
        }

        let mut secret = [0u8; MLKEM_SECRET_KEY_LEN];
        let mut secret_len = secret.len();
        if EVP_PKEY_get_raw_private_key(pkey.0, secret.as_mut_ptr(), &mut secret_len) != 1
            || secret_len != MLKEM_SECRET_KEY_LEN
        {
            return Err(map_internal_error("EVP_PKEY_get_raw_private_key"));
        }

        Ok((secret, public))
    }
}

fn encapsulate_with_public(
    public: &[u8],
) -> CryptoResult<([u8; MLKEM_CIPHERTEXT_LEN], [u8; MLKEM_SHARED_SECRET_LEN])> {
    if public.len() != MLKEM_PUBLIC_KEY_LEN {
        return Err(CryptoError::InvalidKey(
            "Invalid ML-KEM public key length".into(),
        ));
    }

    unsafe {
        let pkey_ptr = EVP_PKEY_kem_new_raw_public_key(NID_MLKEM768, public.as_ptr(), public.len());
        if pkey_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_kem_new_raw_public_key"));
        }
        let pkey = EvpPkey(pkey_ptr);

        let ctx_ptr = EVP_PKEY_CTX_new(pkey.0, null_mut());
        if ctx_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_CTX_new"));
        }
        let ctx = EvpPkeyCtx(ctx_ptr);

        let mut ciphertext = [0u8; MLKEM_CIPHERTEXT_LEN];
        let mut ciphertext_len = ciphertext.len();
        let mut shared_secret = [0u8; MLKEM_SHARED_SECRET_LEN];
        let mut shared_secret_len = shared_secret.len();

        let ret = EVP_PKEY_encapsulate(
            ctx.0,
            ciphertext.as_mut_ptr(),
            &mut ciphertext_len,
            shared_secret.as_mut_ptr(),
            &mut shared_secret_len,
        );

        if ret != 1
            || ciphertext_len != MLKEM_CIPHERTEXT_LEN
            || shared_secret_len != MLKEM_SHARED_SECRET_LEN
        {
            return Err(map_internal_error("EVP_PKEY_encapsulate"));
        }

        Ok((ciphertext, shared_secret))
    }
}

fn decapsulate_with_secret(
    secret: &[u8],
    ciphertext: &[u8],
) -> CryptoResult<[u8; MLKEM_SHARED_SECRET_LEN]> {
    if secret.len() != MLKEM_SECRET_KEY_LEN {
        return Err(CryptoError::InvalidKey(
            "Invalid ML-KEM secret key length".into(),
        ));
    }
    if ciphertext.len() != MLKEM_CIPHERTEXT_LEN {
        return Err(CryptoError::InvalidCiphertext(
            "Invalid ML-KEM ciphertext length".into(),
        ));
    }

    unsafe {
        let pkey_ptr = EVP_PKEY_kem_new_raw_secret_key(NID_MLKEM768, secret.as_ptr(), secret.len());
        if pkey_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_kem_new_raw_secret_key"));
        }
        let pkey = EvpPkey(pkey_ptr);

        let ctx_ptr = EVP_PKEY_CTX_new(pkey.0, null_mut());
        if ctx_ptr.is_null() {
            return Err(map_internal_error("EVP_PKEY_CTX_new"));
        }
        let ctx = EvpPkeyCtx(ctx_ptr);

        let mut shared_secret = [0u8; MLKEM_SHARED_SECRET_LEN];
        let mut shared_secret_len = shared_secret.len();

        let ret = EVP_PKEY_decapsulate(
            ctx.0,
            shared_secret.as_mut_ptr(),
            &mut shared_secret_len,
            ciphertext.as_ptr(),
            ciphertext.len(),
        );

        if ret != 1 || shared_secret_len != MLKEM_SHARED_SECRET_LEN {
            return Err(CryptoError::DecryptionFailure(
                "EVP_PKEY_decapsulate failed".into(),
            ));
        }

        Ok(shared_secret)
    }
}
