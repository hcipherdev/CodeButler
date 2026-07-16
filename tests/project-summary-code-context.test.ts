import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectProjectSummaryCodeFiles,
  listProjectSummarySafeTrackedPaths,
  readProjectSummaryTrackedFile,
  readTrackedPaths
} from "../src/project-summary/code-context.js";
import { cleanupTempDir, makeTempDir } from "./helpers/temp.js";

describe("project summary code context", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) cleanupTempDir(dir);
    tempDirs = [];
  });

  function createRepo(files: Record<string, string | Uint8Array>): string {
    const rootDir = makeTempDir();
    tempDirs.push(rootDir);
    git(rootDir, ["init", "-q"]);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(rootDir, path, ".."), { recursive: true });
      writeFileSync(join(rootDir, path), content);
    }
    git(rootDir, ["add", "--all"]);
    return rootDir;
  }

  function git(rootDir: string, args: string[]): string {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
  }

  it("selects only tracked candidates by deterministic evidence priority and path", () => {
    const rootDir = createRepo({
      "package.json": JSON.stringify({ main: "src/z-entry.ts", module: "src/a-entry.ts" }),
      "src/a-entry.ts": "export const a = true;\n",
      "src/z-entry.ts": "export const z = true;\n",
      "src/memory-a.ts": "export const memoryA = true;\n",
      "src/memory-z.ts": "export const memoryZ = true;\n",
      "src/recent.ts": "export const recent = true;\n"
    });
    writeFileSync(join(rootDir, "src", "untracked.ts"), "export const secret = 'do not send';\n");

    const input = {
      manifests: [{ path: "package.json", content: "" }],
      memories: [{ relatedFiles: ["src/memory-z.ts", "src/memory-a.ts", "src/untracked.ts"] }],
      commits: [{ changedFiles: ["src/recent.ts", "src/memory-a.ts"] }]
    };
    const first = collectProjectSummaryCodeFiles(rootDir, input);
    const second = collectProjectSummaryCodeFiles(rootDir, input);

    expect(first.map(({ path, selectionReason }) => ({ path, selectionReason }))).toEqual([
      { path: "src/a-entry.ts", selectionReason: "manifest-entrypoint" },
      { path: "src/z-entry.ts", selectionReason: "manifest-entrypoint" },
      { path: "src/memory-a.ts", selectionReason: "promoted-memory" },
      { path: "src/memory-z.ts", selectionReason: "promoted-memory" },
      { path: "src/recent.ts", selectionReason: "recent-commit" }
    ]);
    expect(first.some((file) => file.path === "src/untracked.ts")).toBe(false);
    expect(first[0]).toMatchObject({
      content: "export const a = true;\n",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      originalBytes: 23,
      truncated: false
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("discovers conservative JavaScript, Rust, Python, and Go manifest entrypoints", () => {
    const rootDir = createRepo({
      "package.json": JSON.stringify({
        browser: "src/browser.ts",
        bin: { tool: "src/cli.ts" },
        exports: { ".": { import: "./src/index.ts" }, "./worker": "./src/worker.ts" }
      }),
      "src/browser.ts": "export {};\n",
      "src/cli.ts": "export {};\n",
      "src/index.ts": "export {};\n",
      "src/worker.ts": "export {};\n",
      "Cargo.toml": "[[bin]]\nname = \"server\"\npath = \"rust/server.rs\"\n",
      "src/main.rs": "fn main() {}\n",
      "src/lib.rs": "pub fn library() {}\n",
      "rust/server.rs": "fn main() {}\n",
      "pyproject.toml": "[project.scripts]\nserve = \"app.cli:main\"\n[tool.setuptools]\npy-modules = [\"worker\"]\n",
      "app/cli.py": "def main(): pass\n",
      "worker.py": "pass\n",
      "go.mod": "module example.test/tool\n",
      "main.go": "package main\n",
      "cmd/api/main.go": "package main\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [
        { path: "package.json", content: "" },
        { path: "Cargo.toml", content: "" },
        { path: "pyproject.toml", content: "" },
        { path: "go.mod", content: "" }
      ],
      memories: [],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual([
      "app/cli.py",
      "cmd/api/main.go",
      "main.go",
      "rust/server.rs",
      "src/browser.ts",
      "src/cli.ts",
      "src/index.ts",
      "src/lib.rs",
      "src/main.rs",
      "src/worker.ts",
      "worker.py"
    ]);
  });

  it("uses a locale-independent normalized path tiebreak", () => {
    const rootDir = createRepo({
      "src/Z.ts": "export const upper = true;\n",
      "src/_underscore.ts": "export const underscore = true;\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["src/_underscore.ts", "src/Z.ts"] }],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual(["src/Z.ts", "src/_underscore.ts"]);
  });

  it("discovers manifest entrypoints declared beyond the transmitted content cap", () => {
    const rootDir = createRepo({
      "package.json": JSON.stringify({ padding: "x".repeat(21_000), main: "src/late-entry.ts" }),
      "src/late-entry.ts": "export const late = true;\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [{ path: "package.json", content: "" }],
      memories: [],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual(["src/late-entry.ts"]);
  });

  it.runIf(sep === "/")("preserves literal POSIX backslashes instead of authorizing a slash-path alias", () => {
    const rootDir = createRepo({
      "safe\\leak.ts": "export const tracked = 'literal backslash';\n"
    });
    mkdirSync(join(rootDir, "safe"), { recursive: true });
    writeFileSync(join(rootDir, "safe", "leak.ts"), "export const secret = 'untracked alias';\n");

    const aliased = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["safe/leak.ts"] }],
      commits: []
    });
    const exact = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["safe\\leak.ts"] }],
      commits: []
    });

    expect(aliased).toEqual([]);
    expect(exact).toEqual([
      expect.objectContaining({
        path: "safe\\leak.ts",
        content: "export const tracked = 'literal backslash';\n"
      })
    ]);
  });

  it("excludes sensitive directory segments from code selection and inventory", () => {
    const rootDir = createRepo({
      "src/safe.ts": "export const safe = true;\n",
      "secrets/config.json": "{\"token\":\"directory-secret\"}\n",
      "Private-Key/config.json": "{\"token\":\"private-key-secret\"}\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["secrets/config.json", "Private-Key/config.json", "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toEqual(expect.arrayContaining(["secrets/config.json", "Private-Key/config.json"]));
  });

  it("excludes force-tracked files that still match Git ignore rules", () => {
    const rootDir = createRepo({
      ".gitignore": "ignored/\n",
      "ignored/forced.ts": "export const secret = 'force tracked';\n",
      "src/safe.ts": "export const safe = true;\n"
    });
    git(rootDir, ["add", "-f", "ignored/forced.ts"]);

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["ignored/forced.ts", "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toContain("ignored/forced.ts");
  });

  it("rejects valid UTF-8 files containing binary control bytes without NUL", () => {
    const rootDir = createRepo({
      "src/control.bin": Buffer.from([0x41, 0x01, 0x42, 0x02, 0x43]),
      "src/document.pdf": "%PDF-1.7\ntext-shaped binary payload\n",
      "src/normal.ts": "export const normal = '\ttext';\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["src/control.bin", "src/document.pdf", "src/normal.ts"] }],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual(["src/normal.ts"]);
  });

  it("excludes credential paths and secret-bearing content from selection and inventory", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "c2VjcmV0LWtleS1tYXRlcmlhbA==",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const rootDir = createRepo({
      ".env.production/config": "provider=remote\n",
      ".npmrc": "//registry.example.test/:_authToken=npm-secret\n",
      ".netrc": "machine example.test login alice password netrc-secret\n",
      ".pypirc": "password = pypi-secret\n",
      ".git-credentials": "https://alice:git-secret@example.test\n",
      "deploy_key": privateKey,
      "keys/deploy": privateKey,
      "src/config.txt": privateKey,
      "src/settings.json": "{\"password\":\"config-secret\"}\n",
      "src/auth.ini": "authToken = auth-secret\n",
      "src/safe.ts": "export const passwordLabel = 'password';\n"
    });
    const candidates = [
      ".env.production/config",
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".git-credentials",
      "deploy_key",
      "keys/deploy",
      "src/config.txt",
      "src/settings.json",
      "src/auth.ini",
      "src/safe.ts"
    ];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: candidates }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toEqual(expect.arrayContaining(candidates.slice(0, -1)));
    expect(JSON.stringify({ selected, inventory })).not.toContain("config-secret");
  });

  it("allows manifest entrypoints that read credentials from the environment", () => {
    const rootDir = createRepo({
      "package.json": JSON.stringify({ main: "src/index.ts" }),
      "src/index.ts": "const apiKey = process.env.API_KEY;\nexport { apiKey };\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [{ path: "package.json", content: "" }],
      memories: [],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual(["src/index.ts"]);
  });

  it("allows ordinary source basenames and dynamic credential reads", () => {
    const rootDir = createRepo({
      "src/login.py": "password = get_password_from_prompt()\n",
      "src/keys.ts": "export const keyNames = ['primary'];\n",
      "src/cert.ts": "export const certificateLabel = 'development';\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["src/login.py", "src/keys.ts", "src/cert.ts"] }],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual([
      "src/cert.ts",
      "src/keys.ts",
      "src/login.py"
    ]);
  });

  it("distinguishes credential config literals from placeholders and code references", () => {
    const rootDir = createRepo({
      "src/literal.ini": "password = hunter2\n",
      "src/template.ini": "password = ${PASSWORD}\n",
      "src/config-reference.ts": "const authToken = config.authToken;\n",
      "src/identifier.py": "password = stored_password\n"
    });
    const candidates = [
      "src/literal.ini",
      "src/template.ini",
      "src/config-reference.ts",
      "src/identifier.py"
    ];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: candidates }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual([
      "src/config-reference.ts",
      "src/identifier.py",
      "src/template.ini"
    ]);
    expect(inventory).not.toContain("src/literal.ini");
  });

  it("excludes standard credential stores and generic literal credential material", () => {
    const rootDir = createRepo({
      ".aws/credentials": "aws_secret_access_key = aws-secret-material\n",
      ".cargo/credentials.toml": "token = cargo-secret-material\n",
      ".docker/config.json": "{\"auth\":\"base64-material\"}\n",
      ".kube/config": "token: kube-secret-material\n",
      "config/secrets.toml": "access_key = config-secret-material\n",
      "secret.txt": "TOKEN = literal-token\n",
      "notes/material.txt": "private_key = inline-secret\n",
      "notes/token.txt": "token = inline-token\n",
      "notes/auth.txt": "auth = inline-auth\n",
      "notes/secret-value.txt": "secret = inline-secret-value\n",
      "notes/access.txt": "access_key = inline-access\n",
      "notes/aws.txt": "aws_secret_access_key = inline-aws\n",
      ".cargo/config.toml": "[build]\ntarget-dir = 'target'\n",
      "src/auth.ts": [
        "export const token = process.env.AUTH_TOKEN;",
        "export const auth = getAuthFromConfig();"
      ].join("\n"),
      "src/secrets.ts": "export const secret = config.secret;\n"
    });
    const unsafe = [
      ".aws/credentials",
      ".cargo/credentials.toml",
      ".docker/config.json",
      ".kube/config",
      "config/secrets.toml",
      "secret.txt",
      "notes/material.txt",
      "notes/token.txt",
      "notes/auth.txt",
      "notes/secret-value.txt",
      "notes/access.txt",
      "notes/aws.txt"
    ];
    const safe = [".cargo/config.toml", "src/auth.ts", "src/secrets.ts"];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: [...unsafe, ...safe] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(safe);
    expect(inventory).not.toEqual(expect.arrayContaining(unsafe));
    expect(JSON.stringify({ selected, inventory })).not.toContain("secret-material");
  });

  it("excludes list-indented and dotted literal credentials plus standalone GitHub tokens", () => {
    const githubToken = `ghp_${"a".repeat(36)}`;
    const rootDir = createRepo({
      "config/list.yaml": "users:\n  - password: yaml-literal\n",
      "config/database.toml": 'database.password = "toml-literal"\n',
      "notes/github.txt": `${githubToken}\n`,
      "src/safe.ts": [
        "const password = process.env.DB_PASSWORD;",
        "const token = getTokenFromPrompt();"
      ].join("\n")
    });
    const unsafe = ["config/list.yaml", "config/database.toml", "notes/github.txt"];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: [...unsafe, "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toEqual(expect.arrayContaining(unsafe));
    expect(JSON.stringify({ selected, inventory })).not.toContain(githubToken);
  });

  it("fails closed for unterminated and very long quoted credential literals", () => {
    const rootDir = createRepo({
      "config/unterminated.ini": 'password = "unterminated-real-secret',
      "config/long.ini": `password = "${"s".repeat(150_000)}"\n`,
      "src/safe.ts": [
        "const password = process.env.DB_PASSWORD;",
        "const token = getTokenFromPrompt();"
      ].join("\n")
    });
    const unsafe = ["config/unterminated.ini", "config/long.ini"];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: [...unsafe, "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toEqual(expect.arrayContaining(unsafe));
  });

  it.runIf(sep === "/")("rejects a tracked file swapped to a symlink between validation and open", () => {
    const rootDir = createRepo({ "src/race.ts": "export const inside = true;\n" });
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    const outsidePath = join(outsideDir, "outside.ts");
    writeFileSync(outsidePath, "export const leaked = 'outside';\n");
    const trackedPaths = readTrackedPaths(rootDir);

    const file = readProjectSummaryTrackedFile(rootDir, "src/race.ts", trackedPaths, 20_000, {
      beforeOpen() {
        rmSync(join(rootDir, "src", "race.ts"));
        symlinkSync(outsidePath, join(rootDir, "src", "race.ts"));
      }
    });

    expect(file).toBeUndefined();
  });

  it("stops inventory reads at the explicit limit", () => {
    const rootDir = createRepo({
      "src/a.ts": "export const a = true;\n",
      "src/b.ts": "export const b = true;\n",
      "src/c.ts": "export const c = true;\n"
    });
    const opened: string[] = [];
    const trackedPaths = readTrackedPaths(rootDir);

    const inventory = listProjectSummarySafeTrackedPaths(rootDir, trackedPaths, 1, {
      beforeOpen(path) {
        opened.push(path);
      }
    });

    expect(inventory).toEqual(["src/a.ts"]);
    expect(opened).toHaveLength(1);
  });

  it("streams large tracked sources with bounded content and a full-byte hash", () => {
    const largeSource = (tail: string) => `${"x".repeat(2 * 1024 * 1024 + 1)}${tail}`;
    const rootDir = createRepo({
      "src/large.txt": largeSource("tail-one"),
      "src/safe.ts": "export const safe = true;\n"
    });
    const trackedPaths = readTrackedPaths(rootDir);

    const before = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["src/large.txt", "src/safe.ts"] }],
      commits: []
    });
    writeFileSync(join(rootDir, "src", "large.txt"), largeSource("tail-two"));
    const after = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: ["src/large.txt", "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir, trackedPaths, 10);

    expect(before.map((file) => file.path)).toEqual(["src/large.txt", "src/safe.ts"]);
    expect(before[0]).toMatchObject({
      content: "x".repeat(20_000),
      originalBytes: largeSource("tail-one").length,
      truncated: true
    });
    expect(after[0]?.content).toBe(before[0]?.content);
    expect(after[0]?.contentHash).not.toBe(before[0]?.contentHash);
    expect(inventory).toContain("src/large.txt");
  });

  it("excludes normalized generated and dependency directory variants", () => {
    const rootDir = createRepo({
      ".deps/cache.ts": "export const dependency = true;\n",
      "__generated__/client.ts": "export const generated = true;\n",
      "third_party/library.ts": "export const thirdParty = true;\n",
      "third-party/library.ts": "export const thirdPartyDash = true;\n",
      "src/safe.ts": "export const safe = true;\n"
    });
    const excluded = [
      ".deps/cache.ts",
      "__generated__/client.ts",
      "third_party/library.ts",
      "third-party/library.ts"
    ];

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: [...excluded, "src/safe.ts"] }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(inventory).not.toEqual(expect.arrayContaining(excluded));
  });

  it("rejects known binary extensions and binary Netpbm magic while allowing text Netpbm", () => {
    const rootDir = createRepo({
      "src/ascii-with-binary-extension.png": "ordinary ASCII content\n",
      "src/binary-netpbm.dat": "P6\n1 1\n255\nABC",
      "src/text-netpbm.dat": "P1\n1 1\n0\n",
      "src/safe.ts": "export const safe = true;\n"
    });

    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{
        relatedFiles: [
          "src/ascii-with-binary-extension.png",
          "src/binary-netpbm.dat",
          "src/text-netpbm.dat",
          "src/safe.ts"
        ]
      }],
      commits: []
    });
    const inventory = listProjectSummarySafeTrackedPaths(rootDir);

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts", "src/text-netpbm.dat"]);
    expect(inventory).not.toEqual(
      expect.arrayContaining(["src/ascii-with-binary-extension.png", "src/binary-netpbm.dat"])
    );
  });

  it("rejects unsafe tracked paths, deleted files, symlinks, and binary content", () => {
    const rootDir = createRepo({
      ".gitignore": "ignored/\n",
      "src/safe.ts": "export const safe = true;\n",
      "src/deleted.ts": "export const gone = true;\n",
      "src/link.ts": "export const replaced = true;\n",
      "linked/inside.ts": "export const linkedParent = true;\n",
      "node_modules/dependency.ts": "export const dependency = true;\n",
      "vendor/dependency.ts": "export const dependency = true;\n",
      "dist/generated.ts": "export const generated = true;\n",
      "Generated/client.ts": "export const generated = true;\n",
      ".code-butler/private.ts": "export const privateState = true;\n",
      ".ENV.local": "PASSWORD=secret\n",
      "config/credentials.json": "{\"token\":\"secret\"}\n",
      "certs/server.PEM": "secret certificate\n",
      "src/binary.ts": Buffer.from([0x74, 0x65, 0x78, 0x74, 0x00, 0x62, 0x69, 0x6e])
    });
    const outsideDir = makeTempDir();
    tempDirs.push(outsideDir);
    writeFileSync(join(outsideDir, "outside.ts"), "export const secret = 'outside';\n");
    writeFileSync(join(outsideDir, "inside.ts"), "export const secret = 'parent symlink';\n");
    rmSync(join(rootDir, "src", "deleted.ts"));
    rmSync(join(rootDir, "src", "link.ts"));
    symlinkSync(join(outsideDir, "outside.ts"), join(rootDir, "src", "link.ts"));
    rmSync(join(rootDir, "linked"), { recursive: true });
    symlinkSync(outsideDir, join(rootDir, "linked"));
    mkdirSync(join(rootDir, "ignored"), { recursive: true });
    writeFileSync(join(rootDir, "ignored", "secret.ts"), "export const ignored = 'secret';\n");

    const candidatePaths = [
      "src/safe.ts",
      "src/deleted.ts",
      "src/link.ts",
      "linked/inside.ts",
      "node_modules/dependency.ts",
      "vendor/dependency.ts",
      "dist/generated.ts",
      "Generated/client.ts",
      ".code-butler/private.ts",
      ".ENV.local",
      "config/credentials.json",
      "certs/server.PEM",
      "src/binary.ts",
      "ignored/secret.ts",
      "../outside.ts"
    ];
    const selected = collectProjectSummaryCodeFiles(rootDir, {
      manifests: [],
      memories: [{ relatedFiles: candidatePaths }],
      commits: []
    });

    expect(selected.map((file) => file.path)).toEqual(["src/safe.ts"]);
    expect(JSON.stringify(selected)).not.toContain("secret");
  });

  it("bounds code content and hashes the complete original bytes beyond the transmitted prefix", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`src/${String(index).padStart(2, "0")}.ts`] = `${String(index).repeat(15_000)}tail-one`;
    }
    const rootDir = createRepo(files);
    const candidates = Object.keys(files);
    const input = { manifests: [], memories: [{ relatedFiles: candidates }], commits: [] };

    const first = collectProjectSummaryCodeFiles(rootDir, input);
    expect(first.length).toBeLessThanOrEqual(12);
    expect(first.reduce((total, file) => total + file.content.length, 0)).toBeLessThanOrEqual(120_000);
    expect(first.every((file) => file.content.length <= 20_000)).toBe(true);
    expect(first[0]).toMatchObject({ originalBytes: 15_008, truncated: false });

    writeFileSync(join(rootDir, "src", "00.ts"), `${"0".repeat(20_000)}tail-one`);
    const beforeTailChange = collectProjectSummaryCodeFiles(rootDir, input);
    writeFileSync(join(rootDir, "src", "00.ts"), `${"0".repeat(20_000)}tail-two`);
    const afterTailChange = collectProjectSummaryCodeFiles(rootDir, input);

    expect(beforeTailChange[0]?.content).toBe("0".repeat(20_000));
    expect(afterTailChange[0]?.content).toBe(beforeTailChange[0]?.content);
    expect(beforeTailChange[0]).toMatchObject({ originalBytes: 20_008, truncated: true });
    expect(afterTailChange[0]?.contentHash).not.toBe(beforeTailChange[0]?.contentHash);
  });
});
