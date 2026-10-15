import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { resolveAuthorization } from "../src/authorization.js";
import { withCredentialRefreshLock } from "../src/credential-refresh-lock.js";
import { DeviceAuthClient } from "../src/device-auth-client.js";
import { createProxySession } from "../src/proxy-session.js";

const [directory, url, mode, cliHome] = process.argv.slice(2);
// Never let the default-lock test touch the real user's home.
if (mode === "default-home")
  assert.equal(os.homedir(), path.resolve(directory));
const file = path.join(directory, "synthetic-credentials.json");
const tokenStore = {
  load: async () => JSON.parse(await readFile(file, "utf8")),
  save: async (value) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const temporary = `${file}.${process.pid}`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, file);
  },
};
const session = createProxySession({
  resolveAuth: () =>
    resolveAuthorization({
      home: cliHome,
      tokenStore,
      authClient: new DeviceAuthClient({ baseUrl: url }),
      ...(mode === "default-home"
        ? {}
        : {
            withRefreshLock: (operation) =>
              mode === "legacy"
                ? operation()
                : withCredentialRefreshLock(operation, { home: directory }),
          }),
    }),
  connectRemote: async () => ({
    listTools: async () => ({ tools: [{ name: "synthetic_tool" }] }),
    close: async () => {},
  }),
});
await session.refresh();
console.log(JSON.stringify(session.snapshot()));
await session.close();
