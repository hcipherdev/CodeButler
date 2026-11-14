// Tests isNetworkUnavailable() in src/cloud/network.ts, and the network flag errorOutcome() in src/cloud/outcome.ts and classifyCloudSyncError() in src/cloud/condition.ts derive from it.
import { describe, expect, it } from "vitest";

import { classifyCloudSyncError } from "../../src/cloud/condition.js";
import { isNetworkUnavailable } from "../../src/cloud/network.js";
import { errorOutcome } from "../../src/cloud/outcome.js";

const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
// Node's fetch hides the lookup failure in the cause.
const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: coded(`getaddrinfo ${code} cloud.example.test`, code) });

describe("network unavailable", () => {
  it("recognises missing DNS, routes and refused connections, including inside a cause", () => {
    for (const error of [fetchFailed("ENOTFOUND"), fetchFailed("EAI_AGAIN"), coded("connect", "ECONNREFUSED"), coded("route", "ENETUNREACH"), new Error("getaddrinfo ENOTFOUND aws-external-anthropic.us-east-1.api.aws")]) {
      expect(isNetworkUnavailable(error)).toBe(true);
    }
  });

  it("does not mistake other failures that mention timeouts or unavailability", () => {
    for (const error of [Object.assign(new Error("denied"), { status: 401 }), new Error("Snapshot block checksum mismatch"),
      new Error("Project is unavailable or no longer initialized"), new Error("Project watch timed out; will retry"), undefined, null]) {
      expect(isNetworkUnavailable(error)).toBe(false);
    }
  });

  it("flags an outcome only for a network failure", () => {
    expect(errorOutcome(fetchFailed("ENOTFOUND"), "cloud")).toEqual({ outcome: "failed", stage: "cloud", reason: "fetch failed", network: true });
    expect(errorOutcome(new Error("Snapshot block checksum mismatch"), "cloud")).toEqual({ outcome: "failed", stage: "cloud", reason: "Snapshot block checksum mismatch" });
  });

  it("keeps the cloud classifier's offline result, now also for an unresolved host", () => {
    expect(classifyCloudSyncError(fetchFailed("ENOTFOUND")).condition).toBe("offline-network");
    expect(classifyCloudSyncError(new Error("Request timed out")).condition).toBe("offline-network");
    expect(classifyCloudSyncError(new Error("SQLite is busy")).condition).toBe("deferred");
  });
});
