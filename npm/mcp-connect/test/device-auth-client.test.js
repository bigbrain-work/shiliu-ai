import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DeviceAuthClient,
  DeviceAuthError,
  createLoginQrCode,
  normalizeTokenResponse,
  removeLoginQrCode,
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

test("creates and removes a temporary PNG QR code for Agent display", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "shiliu-qr-test-"),
  );
  try {
    const qrCodePath = await createLoginQrCode(
      "https://example.test/authorize?state=public-state",
      "ABCD-2345",
      { temporaryDirectory },
    );
    const content = await readFile(qrCodePath);
    assert.deepEqual([...content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal((await stat(qrCodePath)).isFile(), true);
    assert.equal(await removeLoginQrCode(qrCodePath, { temporaryDirectory }), true);
    await assert.rejects(() => stat(qrCodePath), /ENOENT/u);

    const unrelatedPath = path.join(temporaryDirectory, "unrelated.png");
    await writeFile(unrelatedPath, "keep");
    assert.equal(
      await removeLoginQrCode(unrelatedPath, { temporaryDirectory }),
      false,
    );
    assert.equal((await stat(unrelatedPath)).isFile(), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
