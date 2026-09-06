import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REGISTRY_LATEST_URL,
} from "./constants.js";

function parseVersion(value) {
  const match = String(value).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u,
  );
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4] || "",
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return a.numbers[index] > b.numbers[index] ? 1 : -1;
    }
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

export async function checkForUpdates({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl(REGISTRY_LATEST_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(`npm registry 返回 HTTP ${response.status}`);
  const metadata = await response.json();
  const latest = metadata.version;
  if (!latest) throw new Error("npm registry 未返回版本号");
  return {
    current: PACKAGE_VERSION,
    latest,
    updateAvailable: compareVersions(latest, PACKAGE_VERSION) > 0,
  };
}

export async function printUpdateStatus(options = {}) {
  const result = await checkForUpdates(options);
  if (result.updateAvailable) {
    console.log(`发现新版本：${result.current} → ${result.latest}`);
    console.log(`更新命令：npm install -g ${PACKAGE_NAME}@latest`);
  } else {
    console.log(`当前版本：${result.current}；npm latest：${result.latest}`);
  }
  return result;
}
