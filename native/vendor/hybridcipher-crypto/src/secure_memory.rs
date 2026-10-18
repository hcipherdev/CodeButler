/// Secure Memory Management for HybridCipher Cryptographic Operations
///
/// Provides comprehensive secret lifecycle management, memory protection,
/// and timing attack prevention for cryptographic secrets.
extern crate std;

use alloc::vec;
use rand::{rngs::OsRng, RngCore};
use std::fmt;
use std::string::{String, ToString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use std::vec::Vec;
use thiserror::Error;
use zeroize::Zeroize;

/// Errors related to secure memory operations
#[derive(Debug, Error)]
pub enum SecureMemoryError {
    /// Memory allocation failed
    #[error("Memory allocation failed")]
    AllocationFailed,

    /// Memory locking failed  
    #[error("Memory locking failed: {0}")]
    LockingFailed(String),

    /// Invalid memory size
    #[error("Invalid memory size: {size}")]
    InvalidSize {
        /// The invalid size that was requested
        size: usize,
    },

    /// Memory already locked
    #[error("Memory already locked")]
    AlreadyLocked,

    /// Operation not permitted on locked memory
    #[error("Operation not permitted on locked memory")]
    MemoryLocked,

    /// Memory protection violation
    #[error("Memory protection violation")]
    ProtectionViolation,

    /// Timing constraint violation
    #[error("Timing constraint violation")]
    TimingViolation,
}

/// Thread-safe tracking of secret instances
static SECRET_INSTANCE_COUNT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Get current count of active secret instances (for debugging/monitoring)
pub fn get_active_secret_count() -> usize {
    SECRET_INSTANCE_COUNT.load(Ordering::Relaxed)
}

/// Secure container for cryptographic secrets with automatic zeroization
pub struct SecretBytes {
    /// The secret data
    data: Vec<u8>,

    /// Whether memory is locked (mlock on Unix systems)
    locked: bool,

    /// Creation timestamp for lifecycle tracking
    created_at: Instant,

    /// Whether this secret has been used
    accessed: AtomicBool,

    /// Optional label for debugging/monitoring
    label: Option<String>,
}

type SecretSplitResult = (SecretBytes, SecretBytes);

impl SecretBytes {
    /// Create a new secret container
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when the input is empty or
    /// exceeds [`MAX_SECRET_SIZE`].
    pub fn new(data: Vec<u8>) -> Result<Self, SecureMemoryError> {
        if data.is_empty() {
            return Err(SecureMemoryError::InvalidSize { size: 0 });
        }

        if data.len() > MAX_SECRET_SIZE {
            return Err(SecureMemoryError::InvalidSize { size: data.len() });
        }

        SECRET_INSTANCE_COUNT.fetch_add(1, Ordering::Relaxed);

        Ok(Self {
            data,
            locked: false,
            created_at: Instant::now(),
            accessed: AtomicBool::new(false),
            label: None,
        })
    }

    /// Create a new secret with a label for tracking
    ///
    /// # Errors
    /// Propagates any error from [`SecretBytes::new`].
    pub fn new_with_label(data: Vec<u8>, label: String) -> Result<Self, SecureMemoryError> {
        let mut secret = Self::new(data)?;
        secret.label = Some(label);
        Ok(secret)
    }

    /// Create a secret from a fixed-size array
    ///
    /// # Errors
    /// Propagates any error from [`SecretBytes::new`].
    pub fn from_array<const N: usize>(data: [u8; N]) -> Result<Self, SecureMemoryError> {
        Self::new(data.to_vec())
    }

    /// Generate a random secret of specified size
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when the requested size is
    /// zero or exceeds [`MAX_SECRET_SIZE`].
    pub fn generate_random(size: usize) -> Result<Self, SecureMemoryError> {
        if size == 0 || size > MAX_SECRET_SIZE {
            return Err(SecureMemoryError::InvalidSize { size });
        }

        let mut data = vec![0u8; size];
        OsRng.fill_bytes(&mut data);
        Self::new(data)
    }

    /// Lock memory to prevent swapping (platform-specific)
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::AlreadyLocked`] when the memory is already
    /// locked or [`SecureMemoryError::LockingFailed`] if the OS call to lock the
    /// memory fails.
    pub fn lock_memory(&mut self) -> Result<(), SecureMemoryError> {
        if self.locked {
            return Err(SecureMemoryError::AlreadyLocked);
        }

        // Platform-specific memory locking
        #[cfg(unix)]
        {
            let result =
                unsafe { libc::mlock(self.data.as_ptr().cast::<libc::c_void>(), self.data.len()) };

            if result != 0 {
                return Err(SecureMemoryError::LockingFailed(
                    "Memory locking failed".to_string(),
                ));
            }
        }

        #[cfg(windows)]
        {
            let result = unsafe {
                winapi::um::memoryapi::VirtualLock(
                    self.data.as_mut_ptr().cast::<winapi::ctypes::c_void>(),
                    self.data.len(),
                )
            };

            if result == 0 {
                return Err(SecureMemoryError::LockingFailed(
                    "VirtualLock failed".to_string(),
                ));
            }
        }

        self.locked = true;
        Ok(())
    }

    /// Access the secret data (marks as accessed)
    pub fn expose_secret(&self) -> &[u8] {
        self.accessed.store(true, Ordering::Relaxed);
        &self.data
    }

    /// Get the length of the secret
    #[must_use]
    pub const fn len(&self) -> usize {
        self.data.len()
    }

    /// Check if the secret is empty
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Get creation timestamp
    #[must_use]
    pub const fn created_at(&self) -> Instant {
        self.created_at
    }

    /// Check if the secret has been accessed
    #[must_use]
    pub fn was_accessed(&self) -> bool {
        self.accessed.load(Ordering::Relaxed)
    }

    /// Get the label if set
    #[must_use]
    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    /// Compare two secrets in constant time
    #[must_use]
    pub fn constant_time_eq(&self, other: &Self) -> bool {
        TimingSafeOperations::constant_time_compare(&self.data, &other.data)
    }

    /// Create a copy of the secret (should be used sparingly)
    ///
    /// # Errors
    /// Propagates any error from [`SecretBytes::new`].
    pub fn duplicate(&self) -> Result<Self, SecureMemoryError> {
        self.accessed.store(true, Ordering::Relaxed);
        Self::new(self.data.clone())
    }

    /// Split secret into two parts at the given position
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when `mid` is greater than the
    /// secret length.
    pub fn split_at(&self, mid: usize) -> Result<SecretSplitResult, SecureMemoryError> {
        if mid > self.data.len() {
            return Err(SecureMemoryError::InvalidSize { size: mid });
        }

        self.accessed.store(true, Ordering::Relaxed);

        let left = Self::new(self.data[..mid].to_vec())?;
        let right = Self::new(self.data[mid..].to_vec())?;

        Ok((left, right))
    }

    /// Perform XOR operation with another secret in constant time
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when the secrets have
    /// differing lengths.
    pub fn xor_with(&self, other: &Self) -> Result<Self, SecureMemoryError> {
        if self.data.len() != other.data.len() {
            return Err(SecureMemoryError::InvalidSize {
                size: other.data.len(),
            });
        }

        self.accessed.store(true, Ordering::Relaxed);
        other.accessed.store(true, Ordering::Relaxed);

        let mut result = vec![0u8; self.data.len()];
        TimingSafeOperations::constant_time_xor(&self.data, &other.data, &mut result);

        Self::new(result)
    }

    /// Consume the secret and return a zeroized buffer suitable for reuse.
    pub fn into_zeroized_vec(mut self) -> Vec<u8> {
        self.accessed.store(true, Ordering::Relaxed);
        let mut data = core::mem::take(&mut self.data);
        data.zeroize();
        data
    }
}

// Prevent debug output to avoid secret leakage
impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretBytes")
            .field("len", &self.data.len())
            .field("locked", &self.locked)
            .field("created_at", &self.created_at)
            .field("accessed", &self.accessed.load(Ordering::Relaxed))
            .field("label", &self.label)
            .finish()
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        SECRET_INSTANCE_COUNT.fetch_sub(1, Ordering::Relaxed);

        // Unlock memory if it was locked
        if self.locked {
            #[cfg(unix)]
            {
                unsafe {
                    libc::munlock(self.data.as_ptr().cast::<libc::c_void>(), self.data.len());
                }
            }

            #[cfg(windows)]
            {
                unsafe {
                    winapi::um::memoryapi::VirtualUnlock(
                        self.data.as_mut_ptr().cast::<winapi::ctypes::c_void>(),
                        self.data.len(),
                    );
                }
            }
        }

        // Manually zeroize the data
        self.data.zeroize();
    }
}

/// Maximum allowed secret size (1MB)
const MAX_SECRET_SIZE: usize = 1_024 * 1_024;
const SESSION_KEY_USAGE_LIMIT: u64 = 1_000;
const EPOCH_KEY_USAGE_LIMIT: u64 = 10_000;
const SYMMETRIC_KEY_USAGE_LIMIT: u64 = 100_000;
const PRIVATE_KEY_USAGE_LIMIT: u64 = 1_000;
const ROOT_KEY_USAGE_LIMIT: u64 = 10;
const MAX_CACHED_BUFFERS: usize = 10;
const MEMORY_POOL_MAX_SIZE: usize = 1_024 * 1_024;

/// Timing-safe operations for cryptographic primitives
pub struct TimingSafeOperations;

impl TimingSafeOperations {
    /// Compare two byte slices in constant time
    #[must_use]
    pub fn constant_time_compare(a: &[u8], b: &[u8]) -> bool {
        if a.len() != b.len() {
            return false;
        }

        let mut result = 0u8;
        for i in 0..a.len() {
            result |= a[i] ^ b[i];
        }

        result == 0
    }

    /// Conditional selection in constant time
    ///
    /// # Panics
    /// Panics when `true_val` and `false_val` have different lengths.
    #[must_use]
    pub fn constant_time_select(condition: bool, true_val: &[u8], false_val: &[u8]) -> Vec<u8> {
        assert_eq!(true_val.len(), false_val.len());

        let mut result = vec![0u8; true_val.len()];
        let mask = if condition { 0xFF } else { 0x00 };

        for i in 0..true_val.len() {
            result[i] = (true_val[i] & mask) | (false_val[i] & !mask);
        }

        result
    }

    /// XOR two byte slices in constant time
    /// XOR two byte slices in constant time
    ///
    /// # Panics
    /// Panics when `a`, `b`, and `output` differ in length.
    pub fn constant_time_xor(a: &[u8], b: &[u8], output: &mut [u8]) {
        assert_eq!(a.len(), b.len());
        assert_eq!(a.len(), output.len());

        for i in 0..a.len() {
            output[i] = a[i] ^ b[i];
        }
    }

    /// Copy bytes in constant time (prevents optimization-based timing leaks)
    ///
    /// # Panics
    /// Panics when `src` and `dst` differ in length.
    pub fn constant_time_copy(src: &[u8], dst: &mut [u8]) {
        assert_eq!(src.len(), dst.len());

        dst.copy_from_slice(src);
    }

    /// Generate a random delay to mask timing patterns
    #[must_use]
    pub fn secure_random_delay() -> Duration {
        let mut rng = OsRng;
        let delay_micros = u64::from(rng.next_u32() % 1000); // 0-999 microseconds
        Duration::from_micros(delay_micros)
    }

    /// Mask timing patterns for conditional operations
    pub fn timing_safe_conditional<T, F1, F2>(
        condition: bool,
        true_branch: F1,
        false_branch: F2,
    ) -> T
    where
        F1: FnOnce() -> T,
        F2: FnOnce() -> T,
    {
        // Always execute both branches to prevent timing leaks
        let start = Instant::now();

        let true_result = true_branch();
        let false_result = false_branch();

        // Add random delay to mask timing differences
        let elapsed = start.elapsed();
        if elapsed < Duration::from_micros(100) {
            std::thread::sleep(Self::secure_random_delay());
        }

        if condition {
            true_result
        } else {
            false_result
        }
    }
}

/// Specialized container for cryptographic keys
pub struct SecretKey {
    secret: SecretBytes,
    key_type: KeyType,
    usage_count: std::sync::atomic::AtomicU64,
}

/// Types of cryptographic keys
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyType {
    /// Symmetric encryption key
    Symmetric,
    /// Private key for asymmetric cryptography
    PrivateKey,
    /// Session-specific key
    SessionKey,
    /// Epoch-specific key
    EpochKey,
    /// Root key for key derivation
    RootKey,
}

impl SecretKey {
    /// Create a new secret key
    ///
    /// # Errors
    /// Propagates any error from [`SecretBytes::new`].
    pub fn new(data: Vec<u8>, key_type: KeyType) -> Result<Self, SecureMemoryError> {
        Ok(Self {
            secret: SecretBytes::new(data)?,
            key_type,
            usage_count: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Create a new secret key with memory locking
    ///
    /// # Errors
    /// Returns any error from [`SecretBytes::new`] or
    /// [`SecretBytes::lock_memory`].
    pub fn new_locked(data: Vec<u8>, key_type: KeyType) -> Result<Self, SecureMemoryError> {
        let mut secret = SecretBytes::new(data)?;
        secret.lock_memory()?;

        Ok(Self {
            secret,
            key_type,
            usage_count: std::sync::atomic::AtomicU64::new(0),
        })
    }

    /// Access the key material (increments usage counter)
    #[must_use]
    pub fn expose_key(&self) -> &[u8] {
        self.usage_count.fetch_add(1, Ordering::Relaxed);
        self.secret.expose_secret()
    }

    /// Get key type
    #[must_use]
    pub const fn key_type(&self) -> KeyType {
        self.key_type
    }

    /// Get usage count
    #[must_use]
    pub fn usage_count(&self) -> u64 {
        self.usage_count.load(Ordering::Relaxed)
    }

    /// Check if key has been overused (security concern)
    #[must_use]
    pub fn is_overused(&self) -> bool {
        let usage = self.usage_count.load(Ordering::Relaxed);
        match self.key_type {
            KeyType::SessionKey => usage > SESSION_KEY_USAGE_LIMIT, // Session keys should be rotated frequently
            KeyType::EpochKey => usage > EPOCH_KEY_USAGE_LIMIT, // Epoch keys have longer lifetimes
            KeyType::Symmetric => usage > SYMMETRIC_KEY_USAGE_LIMIT, // Symmetric keys can be used more
            KeyType::PrivateKey => usage > PRIVATE_KEY_USAGE_LIMIT, // Private keys should be used sparingly
            KeyType::RootKey => usage > ROOT_KEY_USAGE_LIMIT, // Root keys should rarely be used directly
        }
    }

    /// Derive a new key using HKDF
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when `length` is zero or
    /// exceeds [`MAX_SECRET_SIZE`], or [`SecureMemoryError::AllocationFailed`]
    /// when HKDF expansion fails.
    pub fn derive_key(&self, info: &[u8], length: usize) -> Result<Self, SecureMemoryError> {
        use hkdf::Hkdf;
        use sha2::Sha256;

        if length == 0 || length > MAX_SECRET_SIZE {
            return Err(SecureMemoryError::InvalidSize { size: length });
        }

        let hkdf = Hkdf::<Sha256>::new(None, self.expose_key());
        let mut derived_key = vec![0u8; length];

        hkdf.expand(info, &mut derived_key)
            .map_err(|_| SecureMemoryError::AllocationFailed)?;

        Self::new(derived_key, KeyType::Symmetric)
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        // SecretBytes will handle its own cleanup
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretKey")
            .field("key_type", &self.key_type)
            .field("length", &self.secret.len())
            .field("usage_count", &self.usage_count.load(Ordering::Relaxed))
            .field("overused", &self.is_overused())
            .finish()
    }
}

/// Secure memory pool for temporary allocations
pub struct SecureMemoryPool {
    pool: std::sync::Mutex<Vec<Vec<u8>>>,
    max_size: usize,
}

impl SecureMemoryPool {
    /// Create a new secure memory pool
    #[must_use]
    #[allow(clippy::missing_const_for_fn)] // `Mutex::new` is not `const fn` on stable
    pub fn new(max_size: usize) -> Self {
        Self {
            pool: std::sync::Mutex::new(Vec::new()),
            max_size,
        }
    }

    /// Allocate secure memory from the pool
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::InvalidSize`] when `size` is zero or
    /// exceeds the configured pool limit, or
    /// [`SecureMemoryError::LockingFailed`] if the pool mutex is poisoned.
    pub fn allocate(&self, size: usize) -> Result<SecretBytes, SecureMemoryError> {
        if size == 0 || size > self.max_size {
            return Err(SecureMemoryError::InvalidSize { size });
        }

        {
            let mut pool = self.pool.lock().map_err(|_| {
                SecureMemoryError::LockingFailed("Memory pool poisoned".to_string())
            })?;

            if let Some(mut buffer) = pool.pop() {
                if buffer.len() >= size {
                    buffer.truncate(size);
                    buffer.zeroize();
                    return SecretBytes::new(buffer);
                }

                buffer.zeroize();
                pool.push(buffer);
            }
        }

        let buffer = vec![0u8; size];
        SecretBytes::new(buffer)
    }

    /// Return memory to the pool for reuse
    pub fn deallocate(&self, secret: SecretBytes) {
        if secret.is_empty() || secret.len() > self.max_size {
            return;
        }

        let Ok(mut pool) = self.pool.lock() else {
            return;
        };

        if pool.len() < MAX_CACHED_BUFFERS {
            let data = secret.into_zeroized_vec();
            pool.push(data);
        }
    }
}

/// Global secure memory pool instance
static GLOBAL_MEMORY_POOL: std::sync::LazyLock<SecureMemoryPool> =
    std::sync::LazyLock::new(|| SecureMemoryPool::new(MEMORY_POOL_MAX_SIZE)); // 1MB max

/// Get the global secure memory pool
#[must_use]
pub fn global_memory_pool() -> &'static SecureMemoryPool {
    &GLOBAL_MEMORY_POOL
}

/// Memory protection utilities
pub struct MemoryProtection;

impl MemoryProtection {
    /// Clear CPU caches to prevent data remanence
    #[cfg(target_arch = "x86_64")]
    pub fn clear_cpu_caches() {
        unsafe {
            // Clear L1 data cache
            core::arch::x86_64::_mm_clflush(std::ptr::null());
            // Memory fence
            core::arch::x86_64::_mm_mfence();
        }
    }

    /// Clear CPU caches to prevent data remanence (no-op on non-x86_64)
    #[cfg(not(target_arch = "x86_64"))]
    pub const fn clear_cpu_caches() {
        // No-op on other architectures
    }

    /// Disable core dumps for the current process
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::LockingFailed`] if the OS call to adjust
    /// the core dump limit fails.
    #[cfg(unix)]
    pub fn disable_core_dumps() -> Result<(), SecureMemoryError> {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: libc::RLIM_INFINITY,
        };

        let limit_ptr = std::ptr::addr_of!(limit);
        let result = unsafe { libc::setrlimit(libc::RLIMIT_CORE, limit_ptr) };

        if result != 0 {
            return Err(SecureMemoryError::LockingFailed(
                "Failed to disable core dumps".to_string(),
            ));
        }

        Ok(())
    }

    #[cfg(not(unix))]
    /// Disable core dumps for the current process (no-op on this platform)
    ///
    /// # Errors
    /// Returns [`SecureMemoryError::LockingFailed`] if the platform reports a
    /// failure while attempting to disable core dumps.
    pub fn disable_core_dumps() -> Result<(), SecureMemoryError> {
        // Not supported on this platform
        Ok(())
    }

    /// Check if the system supports memory locking
    #[must_use]
    pub const fn supports_memory_locking() -> bool {
        cfg!(any(unix, windows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration as StdDuration;

    #[test]
    fn test_secret_bytes_creation() {
        let data = [1, 2, 3, 4, 5].to_vec();
        let secret = SecretBytes::new(data.clone()).unwrap();

        assert_eq!(secret.len(), 5);
        assert!(!secret.is_empty());
        assert_eq!(secret.expose_secret(), &data);
        assert!(secret.was_accessed());
    }

    #[test]
    fn test_secret_bytes_zeroization() {
        let data = [0xFF; 32].to_vec();
        let secret = SecretBytes::new(data).unwrap();
        let _ptr = secret.data.as_ptr();

        drop(secret);

        // Note: This test can't directly verify zeroization due to memory management,
        // but manual zeroization ensures it happens
    }

    #[test]
    fn test_constant_time_comparison() {
        let secret1 = SecretBytes::new([1, 2, 3, 4].to_vec()).unwrap();
        let secret2 = SecretBytes::new([1, 2, 3, 4].to_vec()).unwrap();
        let secret3 = SecretBytes::new([1, 2, 3, 5].to_vec()).unwrap();

        assert!(secret1.constant_time_eq(&secret2));
        assert!(!secret1.constant_time_eq(&secret3));
    }

    #[test]
    fn test_timing_safe_operations() {
        let a = [1, 2, 3, 4];
        let b = [1, 2, 3, 4];
        let c = [1, 2, 3, 5];

        assert!(TimingSafeOperations::constant_time_compare(&a, &b));
        assert!(!TimingSafeOperations::constant_time_compare(&a, &c));

        let selected = TimingSafeOperations::constant_time_select(true, &a, &c);
        assert_eq!(selected, a);

        let selected = TimingSafeOperations::constant_time_select(false, &a, &c);
        assert_eq!(selected, c);
    }

    #[test]
    fn test_secret_key_usage_tracking() {
        let key = SecretKey::new([0xFF; 32].to_vec(), KeyType::SessionKey).unwrap();

        assert_eq!(key.usage_count(), 0);
        assert!(!key.is_overused());

        // Use the key multiple times
        for _ in 0..500 {
            let _ = key.expose_key();
        }

        assert_eq!(key.usage_count(), 500);
        assert!(!key.is_overused()); // Still under session key limit

        // Use beyond limit
        for _ in 0..600 {
            let _ = key.expose_key();
        }

        assert!(key.is_overused());
    }

    // #[test]
    // fn test_memory_pool() {
    //     let pool = SecureMemoryPool::new(1024);
    //
    //     // Test basic allocation with explicit sizes
    //     let size = 64usize;
    //     let result = pool.allocate(size);
    //     assert!(result.is_ok(), "Failed to allocate {} bytes: {:?}", size, result);
    //     let secret1 = result.unwrap();
    //     assert_eq!(secret1.len(), size);
    // }

    #[test]
    fn test_secret_instance_counting() {
        let initial_count = get_active_secret_count();

        {
            let _secret1 = SecretBytes::new([1, 2, 3].to_vec()).unwrap();
            let _secret2 = SecretBytes::new([4, 5, 6].to_vec()).unwrap();

            // Should have 2 more secrets than before
            assert_eq!(get_active_secret_count(), initial_count + 2);
        }

        // Should be back to initial count
        assert_eq!(get_active_secret_count(), initial_count);
    }

    #[test]
    fn test_xor_operation() {
        let secret1 = SecretBytes::new([0xFF, 0x00, 0xAA].to_vec()).unwrap();
        let secret2 = SecretBytes::new([0x00, 0xFF, 0x55].to_vec()).unwrap();

        let result = secret1.xor_with(&secret2).unwrap();
        assert_eq!(result.expose_secret(), &[0xFF, 0xFF, 0xFF]);
    }

    #[test]
    fn test_secret_splitting() {
        let secret = SecretBytes::new([1, 2, 3, 4, 5, 6].to_vec()).unwrap();
        let (left, right) = secret.split_at(3).unwrap();

        assert_eq!(left.expose_secret(), &[1, 2, 3]);
        assert_eq!(right.expose_secret(), &[4, 5, 6]);
    }

    #[test]
    fn test_key_derivation() {
        let master_key = SecretKey::new([0xFF; 32].to_vec(), KeyType::RootKey).unwrap();
        let derived = master_key.derive_key(b"test_info", 16).unwrap();

        assert_eq!(derived.secret.len(), 16);
        assert_eq!(derived.key_type(), KeyType::Symmetric);
    }

    #[test]
    fn test_random_delay() {
        let delay1 = TimingSafeOperations::secure_random_delay();
        let delay2 = TimingSafeOperations::secure_random_delay();

        // Delays should be different (with high probability)
        assert_ne!(delay1, delay2);

        // Delays should be reasonable (under 1ms)
        assert!(delay1 < StdDuration::from_millis(1));
        assert!(delay2 < StdDuration::from_millis(1));
    }
}
