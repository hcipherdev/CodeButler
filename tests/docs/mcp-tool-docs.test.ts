// Tests that docs/mcp-setup.md (and MEMORY_SYSTEM.md where present) list every MCP tool registered in src/mcp/tool-groups/ with the right count.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const groups = join(root, "src", "mcp", "tool-groups");
const registered = [...new Set(readdirSync(groups)
  .filter(file => file.endsWith(".ts"))
  .flatMap(file => [...readFileSync(join(groups, file), "utf8").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map(match => match[1]!)))].sort();

describe("MCP tool documentation", () => {
  // MEMORY_SYSTEM.md is a private design document; the public repository has only the setup guide.
  const documents = ["docs/mcp-setup.md", "MEMORY_SYSTEM.md"].filter(path => existsSync(join(root, path)));

  it.each(documents)("%s names every registered tool and states the count", path => {
    const text = readFileSync(join(root, path), "utf8");
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter(tool => !text.includes(`\`${tool}`))).toEqual([]);
    expect(text).toContain(`exposes ${registered.length} tools`);
  });
});
