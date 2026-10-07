import { runProxy } from "../src/proxy.js";

await runProxy({
  diagnosticReporter: { path: "", available: () => false, record: async () => {} },
  resolveAuth: async () => ({ token: "", source: "none" }),
  remoteConnector: async () => { throw new Error("Anonymous proxy must not connect to business endpoints"); },
});
