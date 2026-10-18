//! Deterministic, verifiable epoch ID mapping utilities.
//!
//! Provides zero-trust friendly conversion between client `u64` epoch IDs and
//! server-stored `Uuid`s using group-specific public context. Clients can
//! verify that the server has not remapped epoch identifiers.
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Deterministic and verifiable mapping between u64 epoch IDs and UUIDs.
///
/// Design:
/// - `Uuid[0..8]` stores the big-endian `u64` `epoch_id`.
/// - `Uuid[8..16]` stores the first 8 bytes of `SHA-256(group_context || epoch_id || "epoch-map-v1")`.
///
/// Properties:
/// - Deterministic across devices given the same `group_context`.
/// - Verifiable on the client: given a UUID, recover u64 from first 8 bytes and
///   recompute/check the MAC bytes in the second half. Reject if mismatch.
/// - Server cannot undetectably remap epoch IDs because clients verify the mapping.
pub struct EpochIdMapper;

impl EpochIdMapper {
    /// Convert a `u64` epoch ID to a `Uuid` using the provided group context bytes
    #[must_use]
    pub fn u64_to_uuid(epoch_id: u64, group_context: &[u8]) -> Uuid {
        let mut hasher = Sha256::new();
        hasher.update(group_context);
        hasher.update(epoch_id.to_be_bytes());
        hasher.update(b"epoch-map-v1");
        let mac = hasher.finalize();

        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&epoch_id.to_be_bytes());
        bytes[8..16].copy_from_slice(&mac[..8]);
        Uuid::from_bytes(bytes)
    }

    /// Convert a `Uuid` epoch ID to `u64` using the provided group context bytes.
    /// Returns `Some(u64)` if the `Uuid` is consistent with the mapping; otherwise `None`.
    #[must_use]
    pub fn uuid_to_u64(uuid: Uuid, group_context: &[u8]) -> Option<u64> {
        let bytes = uuid.as_bytes();
        let mut epoch_bytes = [0u8; 8];
        epoch_bytes.copy_from_slice(&bytes[..8]);
        let epoch_id = u64::from_be_bytes(epoch_bytes);

        let mut hasher = Sha256::new();
        hasher.update(group_context);
        hasher.update(epoch_id.to_be_bytes());
        hasher.update(b"epoch-map-v1");
        let mac = hasher.finalize();

        if mac[..8] == bytes[8..16] {
            Some(epoch_id)
        } else {
            None
        }
    }

    /// Verify the mapping consistency between a `u64` epoch ID and a `Uuid` for the given group context
    #[must_use]
    pub fn verify_epoch_mapping(u64_id: u64, uuid: Uuid, group_context: &[u8]) -> bool {
        Self::u64_to_uuid(u64_id, group_context) == uuid
    }
}
