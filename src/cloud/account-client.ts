import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { installationDeviceId } from "../memory/origin.js";
import { NativeSecurity, type SecurityStatus } from "./native-security.js";
import { EncryptionError, type EncryptionState } from "./crypto-helper.js";
import { canonical, DEVICE_NONCE_EXPIRED, documentHash, type EnrollmentRequest, type SignedDocument, type SignedVaultRecord } from "./identity-protocol.js";
import type { AccountProfile, EnrollmentState, SessionTokens, VaultState } from "./protocol-types.js";
import { serverUrl, sha256 } from "./state.js";
import { withProjectGate } from "./gate.js";
import { projectCatalogId } from "./resource-identity.js";

interface SessionSnapshot { tokens: SessionTokens | null; revision?: number; epoch?: number }

/** Slowest sustained upload a request is allowed before it times out; small requests keep the base timeout. */
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;
export function requestTimeout(baseMs: number, bodyBytes: number): number {
  return baseMs + Math.ceil(bodyBytes / MIN_UPLOAD_BYTES_PER_SECOND * 1000);
}
export class AccountClient {
  readonly server: string;
  private catalogCapable = false;
  private nativeCapabilities?: { projectCatalog?: number; deviceEnrollment?: number; accountSecrets?: number; sessionWrites?: number };
  readonly networkTiming = { milliseconds: 0, uploadedBytes: 0, downloadedBytes: 0 };
  /** Nonces the server returned with authorized responses, bound to the access token they were issued under. */
  private readonly nonces: Array<{ nonce: string; accessToken: string; receivedAt: number }> = [];
  constructor(server: string, readonly security = NativeSecurity.forServer(server), readonly requestTimeoutMs = 60000,
    readonly authSecurity = security, readonly vaultBase = "/v2/vault", readonly secretIdentity?: NativeSecurity) { this.server = serverUrl(server); }
  static forSecretVault(server: string, vaultId: string): AccountClient {
    return new AccountClient(server, NativeSecurity.forSecretsVault(server, vaultId), 60000,
      NativeSecurity.forServer(server), `/v2/secrets/vaults/${vaultId}`, NativeSecurity.forSecretsDevice(server));
  }
  static forAccountSecrets(server: string, parentProjectId: string, authority = NativeSecurity.forServer(server)): AccountClient {
    return new AccountClient(server, authority.asAccountSecrets(parentProjectId), 60000, authority);
  }
  private async send<T>(path: string, method: string, body: Buffer, token?: string, proof?: SignedDocument, contentType = "application/json"): Promise<T> {
    const started = performance.now();
    this.networkTiming.uploadedBytes += body.length;
    try {
      const response = await fetch(`${this.server}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(requestTimeout(this.requestTimeoutMs, body.length)),
        headers: { "content-type": contentType, "x-butler-project-catalog": "1", ...(this.nativeCapabilities?.accountSecrets === 1 ? { "x-butler-account-secrets": "1" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(proof ? { "x-butler-proof": Buffer.from(canonical(proof)).toString("base64url") } : {}) },
        ...(method !== "GET" && method !== "HEAD" ? { body: new Uint8Array(body) } : {}) });
      const next = response.headers.get("x-butler-next-nonce");
      if (next && token) { this.nonces.push({ nonce: next, accessToken: token, receivedAt: Date.now() }); if (this.nonces.length > 8) this.nonces.shift(); }
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new EncryptionError("verification-failed"); chunks.push(chunk); }
      this.networkTiming.downloadedBytes += size;
      // Encrypted objects can come back as binary frames; errors are always JSON.
      if (response.ok && response.headers.get("content-type") === "application/octet-stream") return Buffer.concat(chunks) as T;
      let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new EncryptionError("incompatible-format"); }
      if (!response.ok) {
        const state = (value as { state?: EncryptionState }).state;
        const allowed = ["storage-full", "request-too-large", "upgrade-required", "lease-expired", "authentication-required", "enrollment-required", "locked", "revoked", "recovery-required", "conflict", "incompatible-format", "verification-failed"];
        const { details, error } = value as { details?: unknown; error?: unknown };
        throw new EncryptionError(state && allowed.includes(state) ? state : response.status === 409 ? "conflict" : response.status === 413 ? "request-too-large" : "verification-failed",
          details ?? (error === DEVICE_NONCE_EXPIRED ? { nonce: "expired" } : undefined));
      }
      return value as T;
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new Error("Cloud request timed out; local memory remains available", { cause: error });
      throw error;
    } finally { this.networkTiming.milliseconds += performance.now() - started; }
  }
  async challenge(email: string, purpose: "register" | "login" | "reset"): Promise<{ challengeId: string; expiresAt: number }> {
    return this.send("/v2/auth/challenge", "POST", Buffer.from(canonical({ email, purpose })));
  }
  async capabilities(): Promise<{ registrationEnabled: boolean; passwordEnabled: boolean; passkeyEnabled: boolean; projectCatalog?: number; deviceEnrollment?: number; accountSecrets?: number }> {
    return this.send("/v2/auth/capabilities", "GET", Buffer.alloc(0));
  }
  async profile(): Promise<AccountProfile> {
    return this.request("/v2/auth/me", "GET", undefined, false);
  }
  async vaultSummary(): Promise<{ projectCount: number; deviceCount: number; usedBytes: number; limitBytes: number }> {
    return this.request(`${this.vaultBase}/summary`);
  }
  async login(challengeId: string, code: string): Promise<void> {
    await this.sessionMutation(() => this.send<SessionTokens>("/v2/auth/verify", "POST", Buffer.from(canonical({ challengeId, code }))));
  }
  async register(challengeId: string, code: string, password: string): Promise<void> {
    await this.sessionMutation(() => this.send<SessionTokens>("/v2/auth/register", "POST", Buffer.from(canonical({ challengeId, code, password }))));
  }
  async passwordLogin(email: string, password: string): Promise<void> {
    await this.sessionMutation(() => this.send<SessionTokens>("/v2/auth/password/login", "POST", Buffer.from(canonical({ email, password }))));
  }
  async setPassword(password: string, currentPassword?: string): Promise<void> {
    await this.sessionMutation(tokens => this.send<SessionTokens>("/v2/auth/password/set", "POST",
      Buffer.from(canonical({ password, ...(currentPassword ? { currentPassword } : {}) })), tokens!.accessToken), true);
  }
  async verifyReset(challengeId: string, code: string): Promise<{ resetToken: string; expiresAt: number }> {
    return this.send("/v2/auth/password/reset/verify", "POST", Buffer.from(canonical({ challengeId, code })));
  }
  async resetPassword(resetToken: string, password: string): Promise<void> {
    await this.send("/v2/auth/password/reset/complete", "POST", Buffer.from(canonical({ resetToken, password })));
  }
  async passkeyStart(kind: "login" | "add", redirectUri: string, label?: string): Promise<{ url: string; verifier: string; state: string }> {
    const session = await this.sessionSnapshot(kind === "add");
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url") + (session.epoch === undefined ? "" : `_${session.epoch}`);
    const codeChallenge = Buffer.from(sha256(verifier), "hex").toString("base64url");
    const body = Buffer.from(canonical({ kind, redirectUri, state, codeChallenge, ...(label ? { label } : {}) }));
    const accessToken = kind === "add" ? session.tokens!.accessToken : undefined;
    const result = await this.send<{ url: string }>("/v2/auth/passkey/start", "POST", body, accessToken);
    if (!result.url.startsWith(this.server + "/auth/passkey/")) throw new EncryptionError("verification-failed");
    return { url: result.url, verifier, state };
  }
  async passkeyExchange(kind: "login" | "add", code: string, verifier: string, state: string): Promise<void> {
    const epoch = /^[A-Za-z0-9_-]{43}_(\d+)$/.exec(state)?.[1];
    await this.sessionMutation(async tokens => {
      const result = await this.send<{ tokens?: SessionTokens; added?: boolean }>("/v2/auth/passkey/exchange", "POST",
        Buffer.from(canonical({ code, verifier, state })), kind === "add" ? tokens!.accessToken : undefined);
      if (kind === "login" && result.tokens) return result.tokens;
      if (kind === "add" && result.added) return;
      throw new EncryptionError("verification-failed");
    }, kind === "add", epoch === undefined ? undefined : Number(epoch));
  }
  async listPasskeys(): Promise<Array<{ id: string; name: string; createdAt: number; lastUsed?: number }>> {
    return this.request("/v2/auth/passkeys", "GET", undefined, false);
  }
  async removePasskey(id: string): Promise<void> { await this.request("/v2/auth/passkeys/" + encodeURIComponent(id), "DELETE", undefined, false); }
  private async sessionSnapshot(authenticated = false): Promise<SessionSnapshot> {
    this.nativeCapabilities ??= await this.security.invoke("capabilities");
    if (authenticated) await this.tokens();
    const session = this.nativeCapabilities.sessionWrites === 1
      ? await this.authSecurity.invoke<SessionSnapshot>("session-read")
      : { tokens: await this.authSecurity.invoke<SessionTokens | null>("tokens-read").catch(error => {
        if (error instanceof EncryptionError && ["locked", "enrollment-required"].includes(error.state)) return null;
        throw error;
      }) };
    if (authenticated && !session.tokens) throw new EncryptionError("authentication-required");
    return session;
  }
  private async sessionMutation(work: (tokens?: SessionTokens) => Promise<SessionTokens | void>, authenticated = false, expectedEpoch?: number): Promise<void> {
    this.nativeCapabilities ??= await this.security.invoke("capabilities");
    const mutate = async () => {
      const session = await this.sessionSnapshot(authenticated);
      if (expectedEpoch !== undefined && session.epoch !== expectedEpoch) throw new EncryptionError("authentication-required");
      const tokens = await work(session.tokens ?? undefined);
      if (tokens) await this.authSecurity.invoke("tokens-save", { tokens, ...(session.epoch === undefined ? {} : { expectedEpoch: session.epoch }) });
      else if (session.epoch !== undefined && (await this.sessionSnapshot()).epoch !== session.epoch) throw new EncryptionError("authentication-required");
    };
    if (this.nativeCapabilities.sessionWrites === 1) return mutate();
    // Older helpers retain session compatibility through the existing process-shared gate.
    mkdirSync(this.authSecurity.directory, { recursive: true, mode: 0o700 });
    return withProjectGate(this.authSecurity.directory, mutate, { waitMs: this.requestTimeoutMs + 5000, name: "Account session change" });
  }
  async tokens(): Promise<SessionTokens> {
    const cached=await this.authSecurity.invoke<SessionTokens|null>("tokens-read");
    if(!cached) throw new EncryptionError("authentication-required");
    if(cached.accessExpiresAt>Date.now()+30000) return cached;
    mkdirSync(this.authSecurity.directory,{recursive:true,mode:0o700});
    return withProjectGate(this.authSecurity.directory,async()=>{
    let tokens = await this.authSecurity.invoke<SessionTokens | null>("tokens-read");
    if (!tokens) throw new EncryptionError("authentication-required");
    if (tokens.accessExpiresAt <= Date.now() + 30000) {
      this.nativeCapabilities ??= await this.security.invoke("capabilities");
      const session = this.nativeCapabilities.sessionWrites === 1 ? await this.authSecurity.invoke<SessionSnapshot>("session-read") : undefined;
      if (session && (!session.tokens || session.tokens.refreshToken !== tokens.refreshToken)) throw new EncryptionError("authentication-required");
      tokens = await this.send<SessionTokens>("/v2/auth/refresh", "POST", Buffer.from(canonical({ refreshToken: tokens.refreshToken })));
      await this.authSecurity.invoke("tokens-save", { tokens, refresh: true, ...(session ? { expectedRevision: session.revision } : {}) });
    }
    return tokens;
    });
  }
  async request<T>(path: string, method = "GET", payload?: unknown, deviceProof = true): Promise<T> {
    return this.exchange<T>(path, method, payload === undefined ? Buffer.alloc(0) : Buffer.from(canonical(payload)), deviceProof, "application/json");
  }
  /** A device-proven POST of raw bytes, such as encrypted objects in binary frames. */
  requestBytes<T>(path: string, body: Buffer): Promise<T> {
    return this.exchange<T>(path, "POST", body, true, "application/octet-stream");
  }
  private async exchange<T>(path: string, method: string, body: Buffer, deviceProof: boolean, contentType: string): Promise<T> {
    this.nativeCapabilities ??= await this.security.invoke("capabilities");
    const attempt = async (tokens: SessionTokens): Promise<T> => {
      const challenge = async () => (await this.send<{ nonce: string }>("/v2/auth/device-challenge", "POST", Buffer.alloc(0), tokens.accessToken)).nonce;
      const sign = (nonce: string) => this.security.invoke<SignedDocument>("proof", { accountId: tokens.accountId, nonce, method, path, bodyHash: sha256(body) });
      let proof: SignedDocument | undefined, pooled = false;
      if (deviceProof) {
        // Server nonces live 60 s; a pooled one well inside that saves the challenge round trip.
        let nonce: string | undefined;
        while (!nonce && this.nonces.length) {
          const entry = this.nonces.shift()!;
          if (entry.accessToken === tokens.accessToken && Date.now() - entry.receivedAt < 45000) nonce = entry.nonce;
        }
        pooled = Boolean(nonce);
        proof = await sign(nonce ?? await challenge());
      }
      try { return await this.send<T>(path, method, body, tokens.accessToken, proof, contentType); }
      catch (error) {
        // Only a rejected pooled nonce is retried: the server refuses it before the request has any effect.
        if (!pooled || !(error instanceof EncryptionError) || (error.details as { nonce?: string } | undefined)?.nonce !== "expired") throw error;
        this.nonces.length = 0;
        return await this.send<T>(path, method, body, tokens.accessToken, await sign(await challenge()), contentType);
      }
    };
    const tokens = await this.tokens();
    let result: T;
    try { result = await attempt(tokens); }
    catch (error) {
      // Every process on this device shares one session, and a refresh by any of them retires the access
      // token at once. A request still in flight — a slow upload batch — is then refused, though the login is
      // fine. The server checks the token before doing any work, so retry once if the stored token moved on.
      if (!(error instanceof EncryptionError) || error.state !== "authentication-required") throw error;
      const current = await this.tokens();
      if (current.accessToken === tokens.accessToken) throw error;
      result = await attempt(current);
    }
    if (path === `${this.vaultBase}/state` && method === "GET") this.assertCatalogCapable(result as VaultState);
    return result;
  }
  /** A vault with a project catalog needs a native helper that understands it. */
  private assertCatalogCapable(state: VaultState): void {
    if (this.vaultBase !== "/v2/vault" || this.catalogCapable || !state.records.at(-1)?.record.projects[projectCatalogId(state.descriptor.vaultId)]) return;
    if (this.nativeCapabilities?.projectCatalog !== 1) throw new EncryptionError("upgrade-required");
    this.catalogCapable = true;
  }
  /**
   * The vault state. A device that already accepted part of the signed history asks only for the records after
   * its last one, a few KB instead of the whole chain; every record is still verified, since the native helper
   * receives the full chain. A server that does not know the request, or no longer holds that record, sends all.
   */
  private async vaultState(local: SecurityStatus | null): Promise<VaultState> {
    const last = local?.descriptor ? local.records.at(-1) : undefined;
    if (!last) return this.request<VaultState>(`${this.vaultBase}/state`, "GET", undefined, false);
    const update = await this.request<VaultState & { after?: number }>(
      `${this.vaultBase}/state?after=${last.record.sequence}&hash=${documentHash(last)}`, "GET", undefined, false);
    const state = update.after === undefined ? { descriptor: update.descriptor, records: update.records } : (() => {
      if (update.after !== last.record.sequence) throw new EncryptionError("verification-failed");
      return { descriptor: update.descriptor, records: [...local!.records, ...update.records] };
    })();
    this.assertCatalogCapable(state);
    return state;
  }
  async logout(): Promise<boolean> {
    this.nativeCapabilities ??= await this.security.invoke("capabilities");
    const signOut = async () => {
      let session: SessionSnapshot;
      for (let attempt = 0;; attempt++) {
        session = await this.sessionSnapshot();
        try { await this.authSecurity.invoke("logout", session.revision === undefined ? {} : { expectedRevision: session.revision }); break; }
        catch (error) { if (!(error instanceof EncryptionError && error.state === "authentication-required") || attempt >= 3) throw error; }
      }
      if (!session.tokens) return true;
      try { await this.send("/v2/auth/logout", "POST", Buffer.alloc(0), session.tokens.accessToken); return true; }
      catch { return false; }
    };
    if (this.nativeCapabilities.sessionWrites === 1) return signOut();
    mkdirSync(this.authSecurity.directory, { recursive: true, mode: 0o700 });
    return withProjectGate(this.authSecurity.directory, signOut, { waitMs: this.requestTimeoutMs + 5000, name: "Account sign-out" });
  }
  async initialize(label: string, deviceId: string = randomUUID()): Promise<SecurityStatus> {
    if (!label.trim() || label.length > 100) throw new Error("Device labels must contain 1–100 characters");
    const tokens = await this.tokens();
    const vaultId = this.vaultBase === "/v2/vault" ? randomUUID() : this.vaultBase.split("/").at(-1);
    if (this.secretIdentity) {
      // Bind this account session to the already approved memory device before creating a new secrets vault.
      await new AccountClient(this.server, this.authSecurity).vaultSummary();
      await this.secretIdentity.invoke("device-create", { accountId: tokens.accountId, deviceId, installationId: installationDeviceId(), label });
      const ids = await this.request<string[]>("/v2/secrets/vaults", "GET", undefined, false);
      const anchor = ids[0] ? AccountClient.forSecretVault(this.server, ids[0]) : undefined;
      if (anchor) await anchor.refreshVault();
      return this.security.invoke("initialize", { accountId: tokens.accountId, vaultId, deviceId, installationId: installationDeviceId(), label,
        identityDirectory: this.secretIdentity.directory, ...(anchor ? { rosterDirectory: anchor.security.directory } : {}) });
    }
    return this.security.invoke("initialize", { accountId: tokens.accountId, vaultId, deviceId, installationId: installationDeviceId(), label });
  }
  async publishInitialization(): Promise<void> {
    const status = await this.security.status();
    if (!status.recoveryReady || !status.descriptor || !status.records[0]) throw new EncryptionError("recovery-required");
    const state = await this.request<VaultState>(`${this.vaultBase}/init`, "POST", { descriptor: status.descriptor, record: status.records[0] }, false);
    await this.security.invoke("accept", { records: state.records });
  }
  async refreshVault(): Promise<SecurityStatus> {
    let local = await this.security.status().catch(error => {
      if (this.secretIdentity && error instanceof EncryptionError && error.state === "locked") return null;
      throw error;
    });
    const state = await this.vaultState(local);
    if ((!local || !local.descriptor) && this.secretIdentity && state.descriptor.rosterSource) {
      const anchor = AccountClient.forSecretVault(this.server, state.descriptor.rosterSource.vaultId);
      await anchor.refreshVault();
      await this.security.invoke("provision-complete", { ...state, identityDirectory: this.secretIdentity.directory,
        rosterDirectory: anchor.security.directory });
      local = await this.security.status();
    }
    if (!local) throw new EncryptionError("enrollment-required");
    if (!local.descriptor || documentHash(local.descriptor) !== documentHash(state.descriptor)) throw new EncryptionError("enrollment-required");
    if (local.staged && state.records.some(r => documentHash(r) === documentHash(local.staged))) await this.security.invoke("stage-commit", { commitment: documentHash(local.staged) });
    return this.security.invoke("accept", { records: state.records });
  }
  async enrollmentRequest(label: string, deviceId: string = randomUUID()): Promise<{ requestId: string; fingerprint: string }> {
    if (!label.trim() || label.length > 100) throw new Error("Device labels must contain 1–100 characters");
    const tokens = await this.tokens(), vault = await this.request<VaultState>(`${this.vaultBase}/state`, "GET", undefined, false);
    if (this.secretIdentity) {
      await this.secretIdentity.invoke("device-create", { accountId: tokens.accountId, deviceId, installationId: installationDeviceId(), label });
      await this.security.invoke("device-clone", { accountId: tokens.accountId, deviceId, identityDirectory: this.secretIdentity.directory });
    } else await this.security.invoke("device-create", { deviceId, installationId: installationDeviceId(), label });
    const { request } = await this.security.invoke<{ request: EnrollmentRequest }>("request", { accountId: tokens.accountId, vaultId: vault.descriptor.vaultId, requestId: randomUUID(), expiresAt: Date.now() + 590000 });
    return this.request(`${this.vaultBase}/enrollment`, "POST", request, false);
  }
  async approve(requestId: string, fingerprint: string): Promise<{ fingerprint: string }> {
    await this.refreshVault();
    const { request } = await this.request<{ request: EnrollmentRequest }>(`${this.vaultBase}/enrollment/${requestId}`, "GET", undefined, false);
    const status = await this.security.status();
    const existing = status.records.find(r => r.record.action === "enroll" && r.record.requestHash === documentHash(request));
    if(existing) {
      if(documentHash(request)!==fingerprint) throw new EncryptionError("verification-failed");
      return {fingerprint:documentHash(status.descriptor)};
    }
    const approval = await this.security.invoke<{ record: SignedVaultRecord; fingerprint: string }>("approve", { request, fingerprint, now: Date.now() });
    const state = await this.request<VaultState>(`${this.vaultBase}/enrollment/${requestId}/approve`, "POST", approval.record);
    await this.security.invoke("accept", { records: state.records });
    return { fingerprint: approval.fingerprint };
  }
  async complete(requestId: string, fingerprint: string): Promise<void> {
    const state = await this.request<VaultState>(`${this.vaultBase}/state`, "GET", undefined, false);
    await this.security.invoke("complete", { ...state, fingerprint });
    await this.request(`${this.vaultBase}/enrollment/${requestId}/complete`, "POST");
    await this.security.invoke("request-clear", { requestId });
  }
  private async requireAnchoredEnrollment(): Promise<void> {
    this.nativeCapabilities ??= await this.security.invoke("capabilities");
    if (this.nativeCapabilities.deviceEnrollment !== 2 || (await this.capabilities()).deviceEnrollment !== 2) throw new EncryptionError("upgrade-required");
  }
  async enrollmentRequestAnchored(label: string): Promise<{ requestId: string; fingerprint: string }> {
    if (!label.trim() || label.length > 100) throw new Error("Device labels must contain 1–100 characters");
    await this.requireAnchoredEnrollment();
    const tokens = await this.tokens();
    const local = await this.security.status();
    if (local.pendingRequest?.accountId === tokens.accountId) {
      const progress = await this.enrollmentProgress();
      if (progress.status === "pending" && local.pendingRequest.kind === "enrollment-v2") return { requestId: local.pendingRequest.requestId, fingerprint: local.pendingRequest.fingerprint };
      if (progress.status === "enrolled") throw new EncryptionError("conflict");
      if (progress.status === "pending") await this.cancelEnrollment(local.pendingRequest.requestId);
    }
    const state = await this.request<VaultState>(`${this.vaultBase}/state`, "GET", undefined, false);
    await this.security.invoke("device-create", { deviceId: randomUUID(), installationId: installationDeviceId(), label });
    const { request } = await this.security.invoke<{ request: EnrollmentRequest }>("request-v2", {
      ...state, accountId: tokens.accountId, vaultId: state.descriptor.vaultId, requestId: randomUUID(), expiresAt: Date.now() + 590000
    });
    return this.request(`${this.vaultBase}/enrollment`, "POST", request, false);
  }
  async approveFingerprint(fingerprint: string): Promise<{ approved: true }> {
    const normalized = fingerprint.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalized)) throw new EncryptionError("verification-failed");
    await this.requireAnchoredEnrollment();
    await this.refreshVault();
    const found = await this.request<EnrollmentState>(`${this.vaultBase}/enrollment/lookup`, "POST", { fingerprint: normalized });
    if (documentHash(found.request) !== normalized || found.request.record.kind !== "enrollment-v2") throw new EncryptionError("upgrade-required");
    const approval = await this.security.invoke<{ record: SignedVaultRecord }>("approve", { request: found.request, fingerprint: normalized, now: Date.now() });
    // A retry may observe an approval already in the accepted chain. Replay that exact record.
    const state = await this.request<VaultState>(`${this.vaultBase}/enrollment/${found.request.record.requestId}/approve`, "POST", approval.record);
    await this.security.invoke("accept", { records: state.records });
    return { approved: true };
  }
  private async finishAnchoredEnrollment(pending: NonNullable<SecurityStatus["pendingRequest"]>, remote: EnrollmentState): Promise<EnrollmentProgress> {
    if (documentHash(remote.request) !== pending.fingerprint || remote.request.record.requestId !== pending.requestId) throw new EncryptionError("verification-failed");
    if (remote.status === "cancelled" || remote.status === "expired") {
      await this.security.invoke("request-clear", { requestId: pending.requestId });
      return { status: remote.status };
    }
    if (remote.status === "pending") return { status: "pending", expiresAt: pending.expiresAt };
    if (remote.request.record.kind !== "enrollment-v2") throw new EncryptionError("upgrade-required");
    const state = await this.request<VaultState>(`${this.vaultBase}/state`, "GET", undefined, false);
    try { await this.security.invoke("complete-v2", { ...state, requestId: pending.requestId }); }
    catch (error) {
      if (!(error instanceof EncryptionError && error.state === "revoked")) throw error;
      // Only a revocation verified against the anchored, signed native chain ends this request.
      await this.security.invoke("request-clear", { requestId: pending.requestId });
      return { status: "revoked" };
    }
    await this.request(`${this.vaultBase}/enrollment/${pending.requestId}/complete`, "POST");
    await this.security.invoke("request-clear", { requestId: pending.requestId });
    return { status: "enrolled" };
  }
  async enrollmentProgress(): Promise<EnrollmentProgress> {
    const tokens = await this.tokens(), local = await this.security.status(), pending = local.pendingRequest;
    if (!pending || pending.accountId !== tokens.accountId) return { status: "none" };
    await this.requireAnchoredEnrollment();
    let remote: EnrollmentState;
    try { remote = await this.request<EnrollmentState>(`${this.vaultBase}/enrollment/${pending.requestId}/status`, "GET", undefined, false); }
    catch (error) {
      if (!(error instanceof EncryptionError && error.state === "enrollment-required") || pending.kind !== "enrollment-v2") throw error;
      // The initial upload may have succeeded remotely but lost its response, or failed before receipt.
      if (pending.expiresAt <= Date.now()) {
        await this.security.invoke("request-clear", { requestId: pending.requestId });
        return { status: "expired" };
      }
      const request = await this.security.invoke<EnrollmentRequest>("request-read");
      if (documentHash(request) !== pending.fingerprint) throw new EncryptionError("verification-failed");
      await this.request(`${this.vaultBase}/enrollment`, "POST", request, false);
      remote = await this.request<EnrollmentState>(`${this.vaultBase}/enrollment/${pending.requestId}/status`, "GET", undefined, false);
    }
    return this.finishAnchoredEnrollment(pending, remote);
  }
  async cancelEnrollment(requestId: string): Promise<EnrollmentProgress> {
    const tokens = await this.tokens(), pending = (await this.security.status()).pendingRequest;
    if (!pending || pending.requestId !== requestId || pending.accountId !== tokens.accountId) throw new EncryptionError("verification-failed");
    const remote = await this.request<EnrollmentState>(`${this.vaultBase}/enrollment/${requestId}/cancel`, "POST", undefined, false);
    return this.finishAnchoredEnrollment(pending, remote);
  }
}
export interface EnrollmentProgress { status: "none" | "pending" | "enrolled" | "cancelled" | "expired" | "revoked"; expiresAt?: number }
