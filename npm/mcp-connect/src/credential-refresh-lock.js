import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

// The default lock follows the OS credential store's user, not a project or npm extraction.
export async function withCredentialRefreshLock(
  operation,
  { home = os.homedir(), stale = 120000, update = 5000, retries = 300 } = {},
) {
  const directory = path.join(home, ".shiliu-ai");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let compromised;
  const release = await lockfile.lock(
    path.join(directory, "credential-refresh"),
    {
      realpath: false,
      stale,
      update,
      retries: { retries, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: () => {
        compromised = new Error("凭据刷新锁已失效，请稍后重试");
      },
    },
  );
  const assertOwned = () => {
    if (compromised) throw compromised;
  };
  try {
    return await operation(assertOwned);
  } finally {
    await release().catch((error) => {
      if (!compromised) throw error;
    });
  }
}
