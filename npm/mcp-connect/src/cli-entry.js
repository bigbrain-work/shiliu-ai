import { createDiagnosticReporter, classifyFatalError, McpDiagnosticError } from "./mcp-diagnostics.js";

export function supportsNode(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 18 || (major === 18 && (minor > 14 || (minor === 14 && patch >= 1)));
}

export async function runEntry({
  argv = process.argv.slice(2), loadCli = () => import("./cli.js"),
  nodeVersion = process.versions.node, reporter = createDiagnosticReporter(), processImpl = process,
} = {}) {
  const mcp = argv.includes("mcp") || argv.includes("proxy");
  let cli;
  let fatalReport;
  const fatal = (error, stage) => {
    if (fatalReport) return fatalReport;
    const classified = classifyFatalError(error, stage);
    processImpl.exitCode = classified.exitCode;
    fatalReport = reporter.record(classified.code, { stage: classified.stage, fatal: true }).catch(() => {});
    return fatalReport;
  };
  // Catch import failures as well as failures that occur after runProxy has returned.
  if (mcp) {
    const terminate = (error) => { void fatal(error, "process").then(() => processImpl.exit(processImpl.exitCode)); };
    processImpl.once("uncaughtException", terminate);
    processImpl.once("unhandledRejection", terminate);
  }
  try {
    if (!supportsNode(nodeVersion)) throw new McpDiagnosticError("RUNTIME_UNAVAILABLE", "runtime_load");
    cli = await loadCli();
  } catch (error) {
    await fatal(error, "runtime_load");
    return;
  }
  try { await cli.runCli(argv); }
  catch (error) {
    if (mcp || error?.diagnosticCode) await fatal(error, "mcp_start");
    else {
      // Preserve the established CLI login/poll error JSON contract outside MCP mode.
      if (argv.includes("--json")) console.error(JSON.stringify(cli.formatCliError(error), null, 2));
      else console.error(`错误：${error.message}`);
      processImpl.exitCode = 1;
    }
  }
}
