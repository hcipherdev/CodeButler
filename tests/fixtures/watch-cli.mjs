import { tsImport } from "tsx/esm/api";
const { runCli } = await tsImport("../../src/cli.ts", import.meta.url);
process.exitCode = await runCli();
