//! Rekey-related cryptographic utilities shared between client and server.

use alloc::vec::Vec;
use uuid::Uuid;

/// Domain separation label used when administrators sign forced cutover commits.
const CUTOVER_COMMIT_DOMAIN: &[u8] = b"hybridcipher.cutover_commit.v1";
/// Length in bytes of a UUID.
const UUID_BYTES: usize = 16;

/// Construct the canonical message administrators must sign when authorizing a forced cutover.
///
/// The message layout is:
/// `b"hybridcipher.cutover_commit.v1" || operation_id.as_bytes() || descriptor_commitment`.
#[must_use]
pub fn cutover_commit_message(operation_id: Uuid, descriptor_commitment: &[u8]) -> Vec<u8> {
    let mut message =
        Vec::with_capacity(CUTOVER_COMMIT_DOMAIN.len() + UUID_BYTES + descriptor_commitment.len());
    message.extend_from_slice(CUTOVER_COMMIT_DOMAIN);
    message.extend_from_slice(operation_id.as_bytes());
    message.extend_from_slice(descriptor_commitment);
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cutover_commit_message_matches_layout() {
        let operation_id = Uuid::new_v4();
        let commitment = [0xABu8; 32];
        let message = cutover_commit_message(operation_id, &commitment);

        assert!(message.starts_with(CUTOVER_COMMIT_DOMAIN));
        assert!(message.ends_with(&commitment));
        assert_eq!(
            message.len(),
            CUTOVER_COMMIT_DOMAIN.len() + UUID_BYTES + commitment.len()
        );
        assert_eq!(
            &message[CUTOVER_COMMIT_DOMAIN.len()..CUTOVER_COMMIT_DOMAIN.len() + UUID_BYTES],
            operation_id.as_bytes()
        );
    }
}
