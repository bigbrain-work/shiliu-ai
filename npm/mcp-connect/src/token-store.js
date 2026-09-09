import {
  KEYRING_ACCOUNT,
  KEYRING_SERVICE,
  PENDING_KEYRING_ACCOUNT,
} from "./constants.js";

function validateTokenSet(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.accessToken !== "string" ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  ) {
    throw new Error("本机凭据格式无效，请重新运行 shiliu login");
  }
  return value;
}

async function createSystemEntry(account) {
  let module;
  try {
    module = await import("@napi-rs/keyring");
  } catch (error) {
    throw new Error(`无法加载系统凭据库：${error.message}`);
  }
  return new module.Entry(KEYRING_SERVICE, account);
}

async function defaultEntryFactory() {
  return createSystemEntry(KEYRING_ACCOUNT);
}

async function defaultPendingEntryFactory() {
  return createSystemEntry(PENDING_KEYRING_ACCOUNT);
}

export class TokenStore {
  constructor({ entryFactory = defaultEntryFactory } = {}) {
    this.entryFactory = entryFactory;
  }

  async save(tokenSet) {
    const entry = await this.entryFactory();
    await entry.setPassword(JSON.stringify(validateTokenSet(tokenSet)));
  }

  async load() {
    const entry = await this.entryFactory();
    try {
      const serialized = await entry.getPassword();
      if (!serialized) return null;
      return validateTokenSet(JSON.parse(serialized));
    } catch (error) {
      if (this.isMissingEntry(error)) return null;
      throw new Error(`无法读取系统凭据库：${error.message}`);
    }
  }

  async clear() {
    const entry = await this.entryFactory();
    try {
      await entry.deletePassword();
    } catch (error) {
      if (!this.isMissingEntry(error)) {
        throw new Error(`无法清除系统凭据库：${error.message}`);
      }
    }
  }

  isMissingEntry(error) {
    return /not found|no entry|no matching|credential.*missing/iu.test(
      error?.message || "",
    );
  }
}

function validatePendingLogin(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.sessionId !== "string" ||
    typeof value.deviceCode !== "string" ||
    typeof value.expiresAt !== "number" ||
    typeof value.interval !== "number" ||
    typeof value.authUrl !== "string" ||
    (value.qrCodePath !== undefined && typeof value.qrCodePath !== "string") ||
    (value.allowLocalhost !== undefined &&
      typeof value.allowLocalhost !== "boolean")
  ) {
    throw new Error("待处理登录会话格式无效，请重新运行 shiliu login");
  }
  return value;
}

export class PendingLoginStore extends TokenStore {
  constructor({ entryFactory = defaultPendingEntryFactory } = {}) {
    super({ entryFactory });
  }

  async save(value) {
    const entry = await this.entryFactory();
    await entry.setPassword(JSON.stringify(validatePendingLogin(value)));
  }

  async load() {
    const entry = await this.entryFactory();
    try {
      const serialized = await entry.getPassword();
      if (!serialized) return null;
      return validatePendingLogin(JSON.parse(serialized));
    } catch (error) {
      if (this.isMissingEntry(error)) return null;
      throw new Error(`无法读取待处理登录会话：${error.message}`);
    }
  }
}
