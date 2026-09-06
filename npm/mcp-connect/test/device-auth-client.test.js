import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceAuthClient,
  DeviceAuthError,
  normalizeTokenResponse,
  waitForDeviceAuthorization,
} from "../src/device-auth-client.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("posts device and refresh tokens in JSON bodies", async () => {
  const requests = [];
  const client = new DeviceAuthClient({
    baseUrl: "https://example.test/auth/device/",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return jsonResponse(200, {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      });
    },
  });

  await client.exchange("device-secret");
  await client.refresh("refresh-secret");

  assert.equal(requests[0].url, "https://example.test/auth/device/token");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    device_code: "device-secret",
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    refresh_token: "refresh-secret",
  });
});

test("polls through authorization_pending without losing the device code", async () => {
  let calls = 0;
  const client = {
    exchange: async (deviceCode) => {
      assert.equal(deviceCode, "device-secret");
      calls += 1;
      if (calls === 1) {
        throw new DeviceAuthError("authorization_pending", "pending", 400);
      }
      return {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      };
    },
  };
  let clock = 0;
  const result = await waitForDeviceAuthorization(
    {
      device_code: "device-secret",
      expires_in: 30,
      interval: 1,
    },
    client,
    {
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.access_token, "access");
});

test("normalizes a token response with an absolute expiry", () => {
  assert.deepEqual(
    normalizeTokenResponse(
      {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "mcp",
      },
      1000,
    ),
    {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 3601000,
      tokenType: "Bearer",
      scope: "mcp",
    },
  );
});
