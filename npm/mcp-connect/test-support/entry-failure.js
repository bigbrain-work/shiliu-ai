import { runEntry } from "../src/cli-entry.js";
import { createDiagnosticReporter } from "../src/mcp-diagnostics.js";

const mode = process.argv[2];
await runEntry({
  argv: ["mcp"],
  reporter: createDiagnosticReporter({ home: process.env.SHILIU_TEST_HOME }),
  loadCli: async () => {
    if (mode === "runtime") throw Object.assign(new Error("sensitive-fixture-value"), { code: "ERR_MODULE_NOT_FOUND" });
    return {
      runCli: async () => {
        if (mode === "late") {
          setTimeout(() => { throw new Error("sensitive-fixture-value"); }, 10);
          return;
        }
        throw new Error("sensitive-fixture-value");
      },
    };
  },
});
