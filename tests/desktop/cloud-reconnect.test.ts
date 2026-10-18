// Tests desktop cloud listing, explicit linking, per-device opt-in, mutation gates, and stale conflict-review contracts.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureProjectConfig } from "../../src/config.js";
import { registerWatchedProject } from "../../src/global-watch.js";
import { activeForegroundIntent } from "../../src/cloud/foreground.js";
import { desktopCloudStatus } from "../../src/desktop/contracts.js";
import { handleDesktopRequest } from "../../src/desktop/service.js";
import type { Binding } from "../../src/cloud/state.js";
import { saveBinding } from "../../src/cloud/state.js";
import { cleanupTempDir, makeTempDir } from "../helpers/temp.js";

const connections = vi.hoisted(() => ({ list: vi.fn(), inspect: vi.fn(), link: vi.fn(), portable: vi.fn(), separate: vi.fn(), review: vi.fn(), resolve: vi.fn() }));
vi.mock("../../src/cloud/project-connections.js", async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), cloudProjectList: connections.list, inspectProjectConnection: connections.inspect, connectCloudProject: connections.link, makeProjectPortable: connections.portable, separateProjectIdentity: connections.separate }));
vi.mock("../../src/cloud/project-review.js", () => ({ reviewProjectConflict: connections.review, resolveProjectConflict: connections.resolve }));
let root: string, home: string, state: Binding;
beforeEach(() => {
  vi.resetAllMocks(); root = makeTempDir(); home = makeTempDir(); vi.stubEnv("CODE_BUTLER_HOME", home);
  ensureProjectConfig(root); registerWatchedProject(root);
  state = { encryptionVersion: 2, projectId: randomUUID(), projectIdentity: randomUUID(), vaultId: randomUUID(), server: "https://example.test", enabled: false, revision: 0, fingerprint: "", status: "disabled" };
});
afterEach(() => { vi.unstubAllEnvs(); cleanupTempDir(root); cleanupTempDir(home); });
const call = (action: string, extra: Record<string, unknown> = {}) => handleDesktopRequest({ version: 1, action, root, ...extra });

describe("desktop portable reconnect", () => {
  it("lists cloud projects before there are registered folders and requests refresh separately", async () => {
    connections.list.mockResolvedValue({ projects: [{ id: state.projectId, label: "Available project", folders: [] }], stale: true });
    await expect(handleDesktopRequest({ version: 1, action: "cloud.projects.list" })).resolves.toMatchObject({ stale: true, projects: [{ folders: [] }] });
    await handleDesktopRequest({ version: 1, action: "cloud.projects.list", refresh: true }); expect(connections.list.mock.calls).toEqual([[undefined], [true]]);
  });

  it("inspects without enabling and keeps explicit linking paused", async () => {
    saveBinding(root, state);
    connections.inspect.mockResolvedValue({ identity: state.projectIdentity, recognition: "existing", projectId: state.projectId });
    await expect(call("cloud.project.inspect", { refresh: true })).resolves.toMatchObject({ recognition: "existing" }); expect(connections.link).not.toHaveBeenCalled();
    connections.link.mockImplementation(async (target, options) => { expect(activeForegroundIntent(target)).toBeDefined(); expect(options).toEqual({ projectId: state.projectId, approveRemote: false }); return state; });
    await expect(call("cloud.project.link", { projectId: state.projectId })).rejects.toMatchObject({ code: "confirmation-required" });
    await expect(call("cloud.project.link", { projectId: state.projectId, confirmed: true })).resolves.toMatchObject({ enabled: false, projectId: state.projectId, recognition: "existing" });
    expect(activeForegroundIntent(root)).toBeUndefined();
  });

  it("starts encrypted sync for a newly linked verified folder", async () => {
    connections.link.mockImplementation(async (_target, options) => { expect(options).toMatchObject({ projectId: state.projectId, enabled: true }); return { ...state, enabled: true }; });
    await expect(call("cloud.project.link", { projectId: state.projectId, confirmed: true })).resolves.toMatchObject({ enabled: true });
  });

  it("passes an explicit create or remote approval choice through the enable gate", async () => {
    const toggle = vi.fn(async (target, enabled, options) => { expect(activeForegroundIntent(target)).toBeDefined(); expect(enabled).toBe(true); expect(options).toEqual({ createNew: true, approveRemote: true }); return { ...state, enabled: true, status: "ready" }; });
    await handleDesktopRequest({ version: 1, action: "cloud.sync.set-enabled", root, enabled: true, createNew: true, approveRemote: true, confirmed: true }, { setCloudSyncEnabled: toggle });
    expect(toggle).toHaveBeenCalledTimes(1); expect(activeForegroundIntent(root)).toBeUndefined();
    await expect(call("cloud.project.link", { projectId: "not-a-uuid", confirmed: true })).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("requires reviewed fingerprints and maps changed reviews to a stale-review response", async () => {
    const review = { projectId: state.projectId, localFingerprint: "a".repeat(64), remote: { revision: 2, commitment: "b".repeat(64) }, canMerge: true, firstConnection: true, localSummary: { memories: 2, candidates: 1, sources: 0 }, cloudSummary: { memories: 3, candidates: 0, sources: 0 } };
    connections.review.mockResolvedValue(review); expect(await call("cloud.sync.review")).toEqual(review);
    connections.resolve.mockImplementation(async target => { expect(activeForegroundIntent(target)).toBeDefined(); throw new Error("Memory changed since the review. Reload the conflict before applying a choice."); });
    await expect(call("cloud.sync.resolve", { choice: "cloud", review, confirmed: true })).rejects.toMatchObject({ code: "stale-review" });
    expect(activeForegroundIntent(root)).toBeUndefined();
    await expect(call("cloud.sync.resolve", { choice: "cloud", confirmed: true })).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("exposes detached, deleted, and identity-conflict states while sync is paused", () => {
    expect(desktopCloudStatus({ ...state, status: "detached" })).toMatchObject({ enabled: false, status: "detached", recognition: "unlinked" });
    expect(desktopCloudStatus({ ...state, status: "deleted" })).toMatchObject({ status: "deleted", recognition: "deleted" });
    expect(desktopCloudStatus({ ...state, syncError: "The project identity changed." })).toMatchObject({ recognition: "conflict", connectionProblem: "The project identity changed." });
  });
});
