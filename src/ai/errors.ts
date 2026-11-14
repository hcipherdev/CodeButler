/** A problem with the connection itself that the person can fix, so callers show its message as is. */
export class AiConnectionError extends Error {
  constructor(message: string) { super(message); this.name = "AiConnectionError"; }
}
