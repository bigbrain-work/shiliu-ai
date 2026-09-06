#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
