import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { FrameDecoder, PROTOCOL_VERSION, encodeFrame, errResult, okResult, type Result } from "./protocol.js";

// Deliberately not imported from ../runtime/load.js: the installed host copy must not pull in ajv/schema (no node_modules).
const homeDir = (): string => process.env.WEBSITE_MCP_HOME || join(homedir(), ".website-mcp");

export const socketPath = (home: string = homeDir()): string => join(home, "bridge.sock");
export const hostLogPath = (home: string = homeDir()): string => join(home, "bridge", "host.log");

const LOG_CAP = 256 * 1024;

function makeLogger(file: string | undefined): (line: string) => void {
  return (line) => {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > LOG_CAP) renameSync(file, file + ".1"); // bounded: one backup
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* logging must never break the relay */
    }
  };
}

export interface HostOptions {
  /** Messages from the browser (native messaging frames). Default: process.stdin. */
  input?: Readable;
  /** Messages to the browser. Default: process.stdout. */
  output?: Writable;
  /** Unix socket path. Default: <home>/bridge.sock. */
  sock?: string;
  /** Log file. Default: <home>/bridge/host.log. Pass null to disable. */
  logFile?: string | null;
}
export interface Host {
  sock: string;
  /** Resolves when the browser side closed and the socket is cleaned up. */
  closed: Promise<void>;
  close(): Promise<void>;
}

interface Pending {
  client: Socket;
  clientId: string;
}

/**
 * Native messaging host. The browser spawns one per extension connection; it relays JSON between any number of
 * socket clients and the extension, remapping request ids so concurrent clients cannot collide.
 */
export async function startHost(opts: HostOptions = {}): Promise<Host> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const sock = opts.sock ?? socketPath();
  const log = makeLogger(opts.logFile === null ? undefined : (opts.logFile ?? hostLogPath()));

  const pending = new Map<string, Pending>();
  const clients = new Set<Socket>();
  let seq = 0;
  let ext: { version: number; extVersion?: string } | undefined;
  let done = false;

  const sendToBrowser = (msg: unknown): void => {
    output.write(encodeFrame(msg));
  };
  const reply = (c: Socket, r: Result): void => {
    if (!c.destroyed) c.write(JSON.stringify(r) + "\n");
  };

  // Stale-socket cleanup: a previous host that crashed leaves the file behind. Last host wins.
  mkdirSync(dirname(sock), { recursive: true });
  // Listen on a private name and rename over `sock` (atomic, last host wins). Node/libuv unlinks the *listening* path on
  // close, so a host whose socket was replaced must not be listening on the shared name or it would delete the newer one.
  const tmpSock = `${sock}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;

  const handleClient = (c: Socket): void => {
    clients.add(c);
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      if (buf.length > 4 * 1024 * 1024) return void c.destroy(); // clients never need more than a tool source + input
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) onClientLine(c, line);
      }
    });
    c.on("close", () => {
      clients.delete(c);
      for (const [k, p] of pending) if (p.client === c) pending.delete(k);
    });
    c.on("error", () => c.destroy());
  };

  const onClientLine = (c: Socket, line: string): void => {
    let m: { id?: string; type?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return reply(c, errResult("", "SCRIPT_ERROR", "bridge: malformed JSON from client"));
    }
    const id = String(m.id ?? "");
    if (m.type === "status") {
      return reply(c, okResult(id, { connected: true, protocolVersion: PROTOCOL_VERSION, extension: ext ?? null, hostPid: process.pid }));
    }
    if (ext && ext.version !== PROTOCOL_VERSION) {
      return reply(c, errResult(id, "PROTOCOL_MISMATCH", `extension speaks protocol ${ext.version}, host speaks ${PROTOCOL_VERSION}; reload the extension or reinstall the bridge`));
    }
    const hostId = `h${++seq}`;
    pending.set(hostId, { client: c, clientId: id }); // before the write: an answer may arrive synchronously
    try {
      sendToBrowser({ ...m, id: hostId });
    } catch (e) {
      pending.delete(hostId);
      return reply(c, errResult(id, "SCRIPT_ERROR", `bridge: ${(e as Error).message}`));
    }
  };

  const decoder = new FrameDecoder();
  const onBrowserMessage = (m: { id?: string; type?: string; version?: number; extVersion?: string }): void => {
    if (m.type === "hello") {
      ext = { version: Number(m.version), extVersion: m.extVersion };
      log(`hello from extension protocol=${m.version} ext=${m.extVersion}`);
      return;
    }
    const p = m.id ? pending.get(m.id) : undefined;
    if (!p) return log(`dropped message for unknown id ${m.id}`);
    pending.delete(m.id as string);
    reply(p.client, { ...(m as Result), id: p.clientId });
  };

  const server: Server = createServer(handleClient);
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    const old = process.umask(0o177);
    server.listen(tmpSock, () => {
      process.umask(old);
      res();
    });
  });
  chmodSync(tmpSock, 0o600);
  const ownIno = statSync(tmpSock).ino; // a later host may replace the socket; only unlink our own
  renameSync(tmpSock, sock);
  log(`listening on ${sock}`);

  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const close = async (): Promise<void> => {
    if (done) return closed;
    done = true;
    for (const [, p] of pending) reply(p.client, errResult(p.clientId, "NO_BRIDGE", "the browser closed the bridge connection; reopen the browser"));
    pending.clear();
    for (const c of clients) c.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    try {
      if (statSync(sock).ino === ownIno) unlinkSync(sock);
    } catch {
      /* already gone */
    }
    log("closed");
    resolveClosed();
  };

  input.on("data", (chunk: Buffer) => {
    try {
      for (const m of decoder.push(chunk)) onBrowserMessage(m as Parameters<typeof onBrowserMessage>[0]);
    } catch (e) {
      log(`bad frame: ${(e as Error).message}`);
      void close();
    }
  });
  input.on("end", () => void close());
  input.on("error", () => void close());

  sendToBrowser({ type: "hello", id: "host", version: PROTOCOL_VERSION });
  return { sock, closed, close };
}

/** Entry point when the browser spawns this file via the wrapper script. */
export async function main(): Promise<void> {
  const h = await startHost();
  await h.closed;
  process.exit(0);
}
