import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions } from "../src/updater.js";

test("compares release and prerelease versions", () => {
  assert.equal(compareVersions("1.3.0", "1.2.2"), 1);
  assert.equal(compareVersions("1.3.0-dev.0", "1.3.0"), -1);
  assert.equal(compareVersions("1.2.2", "1.2.2"), 0);
});
