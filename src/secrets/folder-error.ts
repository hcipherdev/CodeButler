/**
 * A problem with this computer's secrets/ folder that the person can fix: its size, an entry Butler does not
 * copy, or permissions it cannot set. Its message says what to change. Problems with data received from the
 * cloud stay EncryptionError("verification-failed"), since nothing local explains or fixes them.
 */
export class SecretFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretFolderError";
  }
}
