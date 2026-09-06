import assert from "node:assert/strict";
import test from "node:test";

import { API_KEY_ENV } from "../src/constants.js";
import { resolveAuthorization } from "../src/authorization.js";

test("uses an unexpired device access token", async () => {
  const result = await resolveAuthorization({
    tokenStore: {
      load: async () => ({
        accessToken: "device-access",
        refreshToken: "device-refresh",
        expiresAt: 120_000,
      }),
    },
    now: () => 1_000,
  });

  assert.deepEqual(result, { token: "device-access", source: "device" });
});

test("rotates an expiring device token before returning it", async () => {
  let saved;
  const result = await resolveAuthorization({
    tokenStore: {
      load: async () => ({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 30_000,
      }),
      save: async (value) => {
        saved = value;
      },
    },
    authClient: {
      refresh: async (refreshToken) => {
        assert.equal(refreshToken, "old-refresh");
        return {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        };
      },
    },
    now: () => 1_000,
  });

  assert.equal(result.token, "new-access");
  assert.equal(result.source, "device");
  assert.equal(saved.refreshToken, "new-refresh");
});

test("falls back to a legacy API key if the credential store is unavailable", async () => {
  const result = await resolveAuthorization({
    platform: "linux",
    env: { [API_KEY_ENV]: "sk-compatible-secret" },
    tokenStore: {
      load: async () => {
        throw new Error("credential service unavailable");
      },
    },
  });

  assert.equal(result.token, "sk-compatible-secret");
  assert.equal(result.source, "legacy_api_key");
  assert.match(result.warning, /credential service unavailable/u);
});
