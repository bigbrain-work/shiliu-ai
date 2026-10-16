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
    withRefreshLock: (operation) => operation(),
  });

  assert.deepEqual(result, {
    token: "device-access",
    source: "device",
    expiresAt: 120_000,
    refreshed: false,
  });
});

test("rotates an expiring device token before returning it", async () => {
  let saved;
  const result = await resolveAuthorization({
    withRefreshLock: (operation) => operation(),
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
  assert.equal(result.expiresAt, 3_601_000);
  assert.equal(result.refreshed, true);
  assert.equal(saved.refreshToken, "new-refresh");
});

test("invalid_grant rereads fresh credentials without replaying the old token", async () => {
  let stored = { accessToken: "old", refreshToken: "spent", expiresAt: 0 };
  let refreshes = 0,
    sleeps = 0;
  const result = await resolveAuthorization({
    tokenStore: {
      load: async () => stored,
      save: async () => {
        throw new Error("must not overwrite");
      },
    },
    authClient: {
      refresh: async () => {
        refreshes++;
        throw Object.assign(new Error("used"), { code: "invalid_grant" });
      },
    },
    withRefreshLock: (operation) => operation(),
    sleep: async () => {
      sleeps++;
      stored = {
        accessToken: "new",
        refreshToken: "rotated",
        expiresAt: Date.now() + 3600000,
      };
    },
  });
  assert.equal(result.token, "new");
  assert.equal(result.refreshed, false);
  assert.equal(refreshes, 1);
  assert.equal(sleeps, 1);
});

test("real invalid_grant and unrelated errors remain errors", async () => {
  for (const code of ["invalid_grant", "network_failure"]) {
    let sleeps = 0;
    const error = Object.assign(new Error("failed"), { code });
    await assert.rejects(
      resolveAuthorization({
        tokenStore: {
          load: async () => ({
            accessToken: "old",
            refreshToken: "same",
            expiresAt: 0,
          }),
        },
        authClient: {
          refresh: async () => {
            throw error;
          },
        },
        withRefreshLock: (operation) => operation(),
        sleep: async () => {
          sleeps++;
        },
      }),
      (value) => value === error,
    );
    assert.equal(sleeps, code === "invalid_grant" ? 1 : 0);
  }
});

test("lock wait rechecks credential store and does not refresh an already rotated token", async () => {
  let stored = { accessToken: "old", refreshToken: "old", expiresAt: 0 };
  const result = await resolveAuthorization({
    tokenStore: { load: async () => stored },
    authClient: {
      refresh: async () => {
        throw new Error("must not refresh");
      },
    },
    withRefreshLock: async (operation) => {
      stored = {
        accessToken: "new",
        refreshToken: "new",
        expiresAt: Date.now() + 3600000,
      };
      return operation();
    },
  });
  assert.equal(result.token, "new");
});

test("logout during refresh is not undone by saving the refresh response", async () => {
  let stored = { accessToken: "old", refreshToken: "old", expiresAt: 0 };
  const result = await resolveAuthorization({
    tokenStore: {
      load: async () => stored,
      save: async () => {
        throw new Error("must not restore logout");
      },
    },
    authClient: {
      refresh: async () => {
        stored = null;
        return { access_token: "new", refresh_token: "new", expires_in: 3600 };
      },
    },
    withRefreshLock: (operation) => operation(),
  });
  assert.equal(result.source, "none");
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
