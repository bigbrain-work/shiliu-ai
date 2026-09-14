import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

// Verify the published digest against the actual download, not a locally
// recompressed copy: gzip headers and deflate output can vary across runtimes.
export function verifyPublicSkillArchive({
  publicIndex, publicArchive, expectedIndex, expectedArchive,
}) {
  const actual = JSON.parse(publicIndex.toString("utf8"));
  const expected = JSON.parse(expectedIndex.toString("utf8"));
  const digest = actual.skills?.[0]?.digest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Public Skill discovery index has an invalid archive digest.");
  }
  const actualDigest = `sha256:${createHash("sha256").update(publicArchive).digest("hex")}`;
  if (digest !== actualDigest) {
    throw new Error("Public Skill archive digest does not match its discovery index.");
  }
  // Ignore only the compression-dependent digest; still compare all metadata,
  // including schema, description, URL, entry type, and unexpected entries.
  actual.skills[0].digest = expected.skills[0].digest;
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Public Skill discovery metadata differs from the canonical repository source.");
  }
  const options = { maxOutputLength: 16 * 1024 * 1024 };
  if (!gunzipSync(publicArchive, options).equals(gunzipSync(expectedArchive, options))) {
    throw new Error("Public Skill archive contents differ from the canonical repository source.");
  }
  return actualDigest;
}
