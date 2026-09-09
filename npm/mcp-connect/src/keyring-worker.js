import { stdin, stdout } from "node:process";

async function readRequest() {
  let input = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) input += chunk;
  return JSON.parse(input);
}

function validateRequest(request) {
  if (
    !request ||
    !["get", "set", "delete"].includes(request.operation) ||
    typeof request.service !== "string" ||
    typeof request.account !== "string" ||
    (request.operation === "set" && typeof request.password !== "string")
  ) {
    throw new Error("凭据库请求无效");
  }
  return request;
}

try {
  const request = validateRequest(await readRequest());
  const { Entry } = await import("@napi-rs/keyring");
  const entry = new Entry(request.service, request.account);

  if (request.operation === "get") {
    stdout.write(JSON.stringify({ value: await entry.getPassword() }));
  } else if (request.operation === "set") {
    await entry.setPassword(request.password);
    stdout.write(JSON.stringify({ ok: true }));
  } else {
    await entry.deletePassword();
    stdout.write(JSON.stringify({ ok: true }));
  }
} catch (error) {
  process.stderr.write(error?.message || String(error));
  process.exitCode = 1;
}
