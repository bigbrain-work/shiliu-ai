#!/usr/bin/env node

import { formatCliError, runCli } from "../src/cli.js";

runCli().catch((error) => {
  if (process.argv.slice(2).includes("--json")) {
    console.error(JSON.stringify(formatCliError(error), null, 2));
  } else {
    console.error(`错误：${error.message}`);
  }
  process.exitCode = 1;
});
