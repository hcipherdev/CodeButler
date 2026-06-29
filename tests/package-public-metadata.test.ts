import { readFileSync } from "node:fs";
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
  };

  it("publishes discoverable metadata for the public npm package", () => {
    expect(packageJson.name).toBe("code-butler");
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/hcipherdev/CodeButler.git"
    });
    expect(packageJson.bugs).toEqual({
      url: "https://github.com/hcipherdev/CodeButler/issues"
    });
    expect(packageJson.homepage).toBe("https://github.com/hcipherdev/CodeButler#readme");
    expect(packageJson.bin?.["code-butler"]).toBe("./dist/cli.js");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.keywords).toEqual(
      expect.arrayContaining(["mcp", "codex", "claude", "project-memory", "local-first"])
    );
  });
});
