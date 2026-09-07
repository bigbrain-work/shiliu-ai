import { runProxy } from "../src/proxy.js";

await runProxy({
  home: process.env.HOME,
  url: process.argv[2],
  platform: process.platform,
  env: process.env,
  tokenStore: {
    load: async () => null,
  },
});
