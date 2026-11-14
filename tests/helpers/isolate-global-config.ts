// Test setup for globalConfigDir() in src/config.ts: keeps trust records, registrations and global config written by any test out of the real ~/.config/code-butler.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolved, because macOS puts the temp directory behind the /var symlink and the rules store refuses symlinked paths.
process.env.CODE_BUTLER_HOME ??= realpathSync(mkdtempSync(join(tmpdir(), "code-butler-home-")));
