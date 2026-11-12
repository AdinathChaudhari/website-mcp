import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { BridgeError } from "../runtime/errors.js";
import { socketPath } from "./host.js";
import type { Request, Result } from "./protocol.js";

export const NO_BRIDGE_HINT =
  "Run `website-mcp bridge status`. If it says not connected: open the browser with the website-mcp extension loaded (and run `website-mcp bridge install --browser chrome` once).";

type Distribute<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * One request over the bridge socket. Resolves with the extension's `value`; rejects with a BridgeError carrying the
 * wire code. Each call opens its own connection, so any number of CLIs/servers can use the bridge at once.
 */
export function bridgeRequest(req: Distribute<Request>, opts: { timeoutMs?: number; sock?: string } = {}): Promise<unknown> {
  const sock = opts.sock ?? socketPath();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BridgeError("TIMEOUT", `no answer from the browser within ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs,
    );
    c.setEncoding("utf8");
    c.on("connect", () => c.write(JSON.stringify({ ...req, id }) + "\n"));
    c.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let r: Result;
        try {
          r = JSON.parse(line) as Result;
        } catch {
          continue;
        }
        if (r.id !== id) continue;
        if (r.ok) finish(() => resolve(r.value));
        else finish(() => reject(new BridgeError(r.error.code, r.error.message, r.error.details)));
      }
    });
    c.on("error", (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === "ENOENT" || e.code === "ECONNREFUSED"
            ? new BridgeError("NO_BRIDGE", `The browser bridge is not running. ${NO_BRIDGE_HINT}`)
            : new BridgeError("NO_BRIDGE", `bridge socket error: ${e.message}. ${NO_BRIDGE_HINT}`),
        ),
      ),
    );
    c.on("close", () => finish(() => reject(new BridgeError("NO_BRIDGE", `the bridge closed the connection. ${NO_BRIDGE_HINT}`))));
  });
}
