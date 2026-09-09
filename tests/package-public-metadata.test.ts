import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("public package metadata", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    name?: string;
    license?: string;
    repository?: { type?: string; url?: string };
    bugs?: { url?: string };
    homepage?: string;
    bin?: { "code-butler"?: string };
    files?: string[];
    keywords?: string[];
    scripts?: Record<string, string>;
    version?: string;
    engines?: { node?: string };
  };

  it("publishes discoverable metadata for the public npm package", () => {
    expect(packageJson.name).toBe("code-butler");
    expect(packageJson.version).toBe("1.0.0");
    expect(packageJson.engines?.node).toBe(">=24.0.0");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hcipherdev/CodeButler.git"
    });
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/hcipherdev/CodeButler/issues"
    });
    expect(packageJson.homepage).toBe("https://github.com/hcipherdev/CodeButler#readme");
    expect(packageJson.bin?.["code-butler"]).toBe("dist/cli.js");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(["mcp", "codex", "claude", "project-memory", "local-first"])
    );
    expect(packageJson.scripts?.prepack).toBe("npm run build");
    expect(packageJson.scripts?.["test:publish"]).toBe("vitest run --no-file-parallelism --maxWorkers=1 --minWorkers=1");
    expect(packageJson.scripts?.prepublishOnly).toBe("npm run typecheck && npm run test:publish");
  });

  it("uses a cross-platform build helper for public package builds", () => {
    expect(packageJson.scripts?.build).toBe("node scripts/build.mjs");
    expect(packageJson.scripts?.build).not.toMatch(/\bchmod\b|&&/);
    expect(existsSync(join(process.cwd(), "scripts", "build.mjs"))).toBe(true);
  });
});
