import { loadProjectConfig } from "../../config.js";
import {
  auditPrivacy,
  deletePrivacySource,
  exportPrivacy,
  importPrivacy,
  prunePrivacySources,
  scrubPrivacy
} from "../../privacy/service.js";
import { openConfiguredMemoryStore } from "../../storage/open-configured-store.js";

export function runPrivacyCommand(
  args: string[],
  cwd: string,
  stdout: (line: string) => void
): number {
  const [subcommand, ...rest] = args;
  if (
    subcommand !== "audit" && subcommand !== "export" && subcommand !== "import" &&
    subcommand !== "scrub" && subcommand !== "delete" && subcommand !== "prune"
  ) {
    throw new Error("Usage: code-butler privacy <audit|export|import|scrub|delete|prune> ...");
  }
  const json = rest.includes("--json");
  const store = openConfiguredMemoryStore(cwd);
  store.init();
  try {
    if (subcommand === "audit") {
      const unknown = rest.find((value) => value !== "--json");
      if (unknown) throw new Error(`Unknown privacy audit option: ${unknown}`);
      const result = auditPrivacy(store);
      if (json) stdout(JSON.stringify(result, null, 2));
      else {
        stdout("Privacy Audit");
        stdout(`scanned_fields=${result.scannedFields} matches=${result.matches}`);
        for (const finding of result.findings) {
          stdout(`${finding.table}.${finding.field} type=${finding.type} count=${finding.count}`);
        }
      }
      return 0;
    }
    if (subcommand === "import") {
      const inputPath = parseStringFlag(rest, "--input");
      const confirmNonempty = rest.includes("--confirm-nonempty");
      assertKnownFlags(rest, new Set(["--input", "--confirm-nonempty", "--json"]), "import");
      if (!inputPath) {
        throw new Error("Usage: code-butler privacy import --input <file> [--confirm-nonempty] [--json]");
      }
      const result = importPrivacy(store, { inputPath, confirmNonempty });
      if (json) stdout(JSON.stringify(result, null, 2));
      else stdout(`Imported privacy data from ${result.inputPath}`);
      return 0;
    }
    if (subcommand === "scrub") {
      const purgeBackups = rest.includes("--purge-backups");
      const unknown = rest.find((value) => value !== "--json" && value !== "--purge-backups");
      if (unknown) throw new Error(`Unknown privacy scrub option: ${unknown}`);
      const result = scrubPrivacy(store, { purgeBackups });
      if (json) stdout(JSON.stringify(result, null, 2));
      else {
        stdout(`Scrubbed stored privacy content; redactions=${result.redactions}`);
        if (result.purge) {
          stdout(`Purged backups: removed=${result.purge.removed.length} failed=${result.purge.failed.length}`);
        }
      }
      return 0;
    }
    if (subcommand === "delete") {
      const sourceId = parseStringFlag(rest, "--source-id");
      const confirmSourceId = parseStringFlag(rest, "--confirm-delete");
      const purgeBackups = rest.includes("--purge-backups");
      assertKnownFlags(
        rest,
        new Set(["--source-id", "--confirm-delete", "--purge-backups", "--json"]),
        "delete"
      );
      if (!sourceId || !confirmSourceId) {
        throw new Error(
          "Usage: code-butler privacy delete --source-id <id> --confirm-delete <id> [--purge-backups] [--json]"
        );
      }
      const result = deletePrivacySource(store, { sourceId, confirmSourceId, purgeBackups });
      if (json) stdout(JSON.stringify(result, null, 2));
      else {
        stdout(
          `Deleted ${result.sourceType} source ${result.sourceIdHash}; ` +
          `retracted_memories=${result.retractedMemories}`
        );
      }
      return 0;
    }
    if (subcommand === "prune") {
      const dryRun = rest.includes("--dry-run");
      const apply = rest.includes("--apply");
      const purgeBackups = rest.includes("--purge-backups");
      const unknown = rest.find((value) =>
        value !== "--dry-run" && value !== "--apply" &&
        value !== "--purge-backups" && value !== "--json"
      );
      if (unknown) throw new Error(`Unknown privacy prune option: ${unknown}`);
      if (dryRun === apply) {
        throw new Error(
          "Usage: code-butler privacy prune <--dry-run|--apply> [--purge-backups] [--json]"
        );
      }
      const result = prunePrivacySources(store, loadProjectConfig(cwd).retention!, {
        apply,
        purgeBackups
      });
      if (json) stdout(JSON.stringify(result, null, 2));
      else stdout(`Retention prune: selected=${result.selected} deleted=${result.deleted}`);
      return 0;
    }
    const outputPath = parseStringFlag(rest, "--output");
    const raw = rest.includes("--raw");
    const confirmedRaw = rest.includes("--confirm-raw-export");
    assertKnownFlags(
      rest,
      new Set(["--output", "--raw", "--confirm-raw-export", "--json"]),
      "export"
    );
    if (!outputPath) {
      throw new Error("Usage: code-butler privacy export --output <file> [--raw --confirm-raw-export] [--json]");
    }
    const result = exportPrivacy(store, { outputPath, raw, confirmedRaw });
    if (json) stdout(JSON.stringify(result, null, 2));
    else stdout(`Exported ${result.redacted ? "redacted" : "raw"} privacy data to ${result.outputPath}`);
    return 0;
  } finally {
    store.close();
  }
}

function parseStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function assertKnownFlags(args: string[], allowed: ReadonlySet<string>, subcommand: string): void {
  const unknown = args.find((value) => value.startsWith("--") && !allowed.has(value));
  if (unknown) throw new Error(`Unknown privacy ${subcommand} option: ${unknown}`);
}
