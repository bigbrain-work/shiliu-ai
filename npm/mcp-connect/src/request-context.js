import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const REQUEST_IDLE_TIMEOUT_MS = 120000;
export const REQUEST_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;

export function cancelledRequest() {
  return Object.assign(new Error("请求已取消；远端执行结果未知，请勿自动重试。"), { code: "REQUEST_CANCELLED" });
}

export function waitWithSignal(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createRequestContext({ signal, signals = [], deadline = Date.now() + REQUEST_TOTAL_TIMEOUT_MS,
  timeoutMs = REQUEST_IDLE_TIMEOUT_MS, onprogress } = {}) {
  const controller = new AbortController();
  const parents = [...new Set([signal, ...signals].filter(Boolean))];
  const cancel = () => {
    const reason = parents.find((parent) => parent.aborted)?.reason;
    controller.abort(reason instanceof McpError && reason.code === ErrorCode.RequestTimeout ? reason : cancelledRequest());
  };
  for (const parent of parents) {
    if (parent.aborted) cancel();
    else parent.addEventListener("abort", cancel, { once: true });
  }
  const timeout = () => controller.abort(new McpError(ErrorCode.RequestTimeout,
    "请求达到总时长上限；远端执行结果未知，请勿自动重试。"));
  const ensureOpen = () => {
    if (Date.now() >= deadline) timeout();
    controller.signal.throwIfAborted();
  };
  const total = setTimeout(timeout, Math.max(0, deadline - Date.now()));
  return {
    signal: controller.signal, deadline,
    abort: cancel,
    options() {
      ensureOpen();
      const remaining = Math.max(1, deadline - Date.now());
      return {
        signal: controller.signal, timeout: Math.min(timeoutMs, remaining),
        maxTotalTimeout: remaining, resetTimeoutOnProgress: true,
        onprogress(progress) {
          if (!controller.signal.aborted) {
            try { Promise.resolve(onprogress?.(progress)).catch(() => {}); } catch { /* UI progress is best effort. */ }
          }
        },
      };
    },
    run(operation) {
      try { ensureOpen(); } catch (error) { return Promise.reject(error); }
      return waitWithSignal(Promise.resolve().then(() => { ensureOpen(); return operation(); }), controller.signal);
    },
    dispose() { clearTimeout(total); for (const parent of parents) parent.removeEventListener("abort", cancel); },
  };
}

export async function closeBriefly(close, milliseconds = 1000) {
  let timer;
  try { await Promise.race([Promise.resolve().then(close).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
