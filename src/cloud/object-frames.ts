import { EncryptionError } from "./crypto-helper.js";

/**
 * Encrypted objects as binary frames: a 32-byte address, a 4-byte big-endian length, then the bytes. Sent this
 * way instead of base64 inside JSON, a transfer carries a quarter fewer bytes. Limits match the JSON transfer.
 */
export const MAX_FRAMES = 128;
export const MAX_FRAME_BYTES = 67500;

export function encodeObjectFrames(objects: Iterable<readonly [string, Buffer]>, prefix: Buffer = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [prefix];
  for (const [address, bytes] of objects) {
    const header = Buffer.alloc(36);
    header.write(address, 0, "hex");
    header.writeUInt32BE(bytes.length, 32);
    parts.push(header, bytes);
  }
  return Buffer.concat(parts);
}

export function decodeObjectFrames(bytes: Buffer, offset = 0): Map<string, Buffer> {
  const invalid = (): never => { throw new EncryptionError("verification-failed"); };
  const objects = new Map<string, Buffer>();
  while (offset < bytes.length) {
    if (bytes.length - offset < 36 || objects.size >= MAX_FRAMES) invalid();
    const address = bytes.subarray(offset, offset + 32).toString("hex"), length = bytes.readUInt32BE(offset + 32);
    offset += 36;
    if (length > MAX_FRAME_BYTES || bytes.length - offset < length || objects.has(address)) invalid();
    objects.set(address, bytes.subarray(offset, offset + length));
    offset += length;
  }
  return objects;
}

/** A lease id as the 16 bytes that open a binary upload, so the device proof over the body covers it. */
export const leaseBytes = (lease: string): Buffer => Buffer.from(lease.replaceAll("-", ""), "hex");
export function leaseFromBytes(bytes: Buffer): string {
  if (bytes.length < 16) throw new EncryptionError("verification-failed");
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
