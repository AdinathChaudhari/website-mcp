import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ariaSnapshot, capResult } from "../browser/snapshot.js";
import { toErrorPayload } from "../runtime/errors.js";
import { MintSession, RESERVED_NAMES } from "../mint/session.js";
import { listToolNames, readManifest } from "../runtime/load.js";
import { readGuide } from "./guides.js";
import { pageCapture, pageExplore, pageSnapshot, pageTabs } from "../bridge/minting.js";
import { runTool } from "../runtime/run.js";
import { WriteState } from "../runtime/write.js";
import { makeHelper } from "../runtime/runners/playwright.js";

const FIXED = RESERVED_NAMES;

// One long-lived browser + page used only for minting (open/snapshot/explore).
// Saved tools never use it: run_tool launches a fresh context per run.
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page | undefined;

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!browser) browser = await chromium.launch({ headless: process.env.WEBSITE_MCP_HEADED !== "1" });
  if (!context) context = await browser.newContext();
  page = await context.newPage();
  return page;
}

async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  browser = context = page = undefined;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

const fixedTools = [
  {
    name: "open",
    description: "Navigate the minting browser to a URL. Returns final URL, HTTP status and title.",
    inputSchema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "snapshot",
    description: "ARIA snapshot of the current page in the minting browser (capped at 16 KiB, full text spilled to a file).",
    inputSchema: obj({}),
  },
  {
    name: "explore",
    description:
      "Run JavaScript as the body of an async function with `page` (Playwright Page) in scope against the live minting page. Use `return` for the result (JSON-serialisable).",
    inputSchema: obj({ code: { type: "string" } }, ["code"]),
  },
  {
    name: "mint_effect",
    description:
      'Start a mint as "read" (default) or "write". Only a write mint may use `act` or save a tool with effect "write" (browser tools: commitMarks + wm.commit; page tools: wm.fill + wm.handOff). Read the guide "writes" first.',
    inputSchema: obj({ effect: { type: "string", enum: ["read", "write"] } }, ["effect"]),
  },
  {
    name: "act",
    description:
      "Write mints only (mint_effect write). Like explore, but allowed to change the site: runs JavaScript as an async function body with `page` and `wm` (wm.commit(mark, fn) is where saving happens) in the minting browser. dryRun defaults to true (wm.commit skips its function). Claude Code asks you each time. Returns { committed, possibleCommit, marksReached, result }.",
    annotations: { destructiveHint: true },
    inputSchema: obj({ code: { type: "string" }, dryRun: { type: "boolean" } }, ["code"]),
  },
  {
    name: "page_tabs",
    description:
      "Page tools: list the open tabs the website-mcp extension can see in the user's own browser: { id, url, title, active, granted, explore }. granted = the user allowed that site in the extension popup; explore = the popup's explore window is open for it (page_snapshot, page_explore and page_capture need it). Needs the extension loaded and the bridge installed.",
    inputSchema: obj({}),
  },
  {
    name: "page_snapshot",
    description:
      "Page tools: DOM outline of an open tab (roles, accessible names, trimmed text), capped at 16 KiB with the full text spilled to a file. Refused unless the explore window is open for the tab's site.",
    inputSchema: obj({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "page_explore",
    description:
      "Page tools: run JavaScript in an open tab of the user's own browser (a function body; `return` a JSON-serialisable result; `document` is the page's). Read-only exploration only. REFUSED unless the popup's explore window is open for that site (the user opens it in the popup for 1 hour, 1 day, or until the browser closes). Result capped at 16 KiB.",
    inputSchema: obj({ tabId: { type: "integer" }, code: { type: "string" } }, ["tabId", "code"]),
  },
  {
    name: "page_capture",
    description:
      "Page tools: save the tab's outerHTML as a capture of draft `name` (drafts/<name>/captures/<n>.html, folder mode 700, files 600; never commit one). Returns the capture file name to use in capture test cases. Refused unless the explore window is open.",
    inputSchema: obj({ tabId: { type: "integer" }, name: { type: "string" } }, ["tabId", "name"]),
  },
  {
    name: "save_tool",
    description:
      "Save a DRAFT tool (it is not callable as a tool until published). `tool` is the tool.json object (description, input, output JSON Schemas, effect \"read\" or \"write\" (write: needs mint_effect first), kind default \"browser\", site.allowedOrigins, optional resultsPath = dot path to the output's main list). `source` is the tool.mjs text with a default export `async ({ page, input, wm }) => result`. For kind \"page\" the source is `async ({ input, wm }) => result` that runs inside the user's tab (read the guide \"page-tools\" first). Next: save_cases, test_tool, the website-mcp-reviewer subagent, submit_review, publish_tool.",
    inputSchema: obj(
      {
        name: { type: "string", description: "^[a-z][a-z0-9_]{1,62}$" },
        tool: { type: "object" },
        source: { type: "string" },
        signin: { type: "object", description: 'kind "page" only: { marker, loginUrl } -> signin.json. marker = a CSS selector present only while signed in; loginUrl inside site.allowedOrigins.' },
      },
      ["name", "tool", "source"],
    ),
  },
  {
    name: "save_cases",
    description:
      'Save the draft\'s test cases: an array of { name, purpose, input, expect }. expect is "result" (succeeds, main list non-empty), "empty" (succeeds, main list empty), "invalid_input" (tool rejects the input) or "signed_out" (page tools: the signin marker is missing). Page tools also take mode "capture" (default; name the file with "capture": "1.html", from page_capture) or "live" (runs in the user\'s real tab, counts against the live cap). Browser tools default to live. Publishing needs at least 3 (page tools: 3 capture cases, plus one live pass).',
    inputSchema: obj({ name: { type: "string" }, cases: { type: "array", items: { type: "object" } } }, ["name", "cases"]),
  },
  {
    name: "test_tool",
    description: "Run the saved test cases through the normal runtime (no model). which: \"draft\" (default) or \"published\". Writes tests/last-run.json and returns pass/fail per case.",
    inputSchema: obj({ name: { type: "string" }, which: { type: "string", enum: ["draft", "published"] } }, ["name"]),
  },
  {
    name: "publish_tool",
    description:
      "Publish a draft as a callable tool. Page tools also need: a clean static scan (one default export, no import/require, no free variables, none of fetch/XMLHttpRequest/WebSocket/sendBeacon/eval/new Function/chrome./document.cookie/storage writes), at least 3 capture cases all passing, one live pass for the exact source, and for world MAIN a reviewer finding that mentions MAIN; the user then approves the published version in the extension popup before its first run. Refuses without an allow review whose sourceHash matches the current draft (see submit_review), and (with reasons naming failing cases) below 70% pass or under 3 cases, on schema errors, literal URLs outside site.allowedOrigins (a text heuristic: the runtime route guard is the real enforcement), or secret-shaped literals. The draft is copied first and the cases always run on that copy unless this session just tested the same files. Keeps the previous version in .history/<n>/.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "guide",
    description:
      "Minting guidance. topic is one of the authoring guides (core, testing, pagination, search, publication, page-tools, hard-targets, writes); read core first, and the others when the task involves them. An unknown or missing topic returns the list of topics.",
    inputSchema: obj({ topic: { type: "string" } }),
  },
  {
    name: "submit_review",
    description:
      "Record the website-mcp-reviewer subagent's verdict on a DRAFT: verdict \"allow\" or \"deny\", findings (strings or { severity: info|warn|block, message }), and the sourceHash the reviewer reviewed (from save_tool's result). Saves drafts/<name>/review.json. publish_tool refuses unless the verdict is allow and sourceHash still equals the draft's current hash (any edit to tool.mjs or tool.json after the review makes it stale).",
    inputSchema: obj(
      {
        name: { type: "string" },
        verdict: { type: "string", enum: ["allow", "deny"] },
        findings: { type: "array", items: {} },
        sourceHash: { type: "string", description: "64-char hex hash of the reviewed draft" },
      },
      ["name", "verdict", "findings", "sourceHash"],
    ),
  },
  { name: "list_tools", description: "List saved tools.", inputSchema: obj({}) },
  {
    name: "run_tool",
    description: "Run a published tool by name with no model involved: browser tools in a fresh Playwright context, page tools in the matching open tab of the user's own browser via the page bridge. Set draft:true to run the draft instead.",
    inputSchema: obj({ name: { type: "string" }, input: { type: "object" }, draft: { type: "boolean" } }, ["name"]),
    // run_tool can reach write tools too: keep the per-run prompt (the dynamic per-tool entries carry the same hint).
    annotations: { destructiveHint: true },
  },
];

function dynamicTools() {
  const out: { name: string; description: string; inputSchema: object; annotations?: { destructiveHint: boolean } }[] = [];
  for (const n of listToolNames()) {
    if (FIXED.includes(n)) continue;
    try {
      const m = readManifest(n);
      if ((m.input as { type?: unknown }).type !== "object") continue;
      out.push({ name: n, description: m.description ?? `Saved tool ${n}`, inputSchema: m.input, ...(m.effect === "write" ? { annotations: { destructiveHint: true } } : {}) });
    } catch {
      /* skip broken tool folders */
    }
  }
  return out;
}

const text = (value: unknown, label: string, isError = false) => ({
  content: [{ type: "text" as const, text: capResult(typeof value === "string" ? value : JSON.stringify(value, null, 2), label) }],
  ...(isError ? { isError: true } : {}),
});

/** act: like explore, but with wm.commit. The caller has already checked the mint is a write mint. */
async function actCode(p: Page, code: string, dryRun: boolean): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (page: Page, wm: unknown) => Promise<unknown>;
  const state = new WriteState(dryRun);
  let result: unknown;
  try {
    result = await new AsyncFunction("page", "wm", code)(p, makeHelper(state));
    result = result === undefined ? null : JSON.parse(JSON.stringify(result));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ...state.outcome(), dryRun, marksReached: [...state.reached] };
  }
  return { ...state.outcome(), dryRun, marksReached: [...state.reached], result };
}

async function exploreCode(p: Page, code: string): Promise<unknown> {
  // SECURITY NOTE: this executes model-written code inside the server process, by design.
  // It is the core of the minting workflow; the server is a local, user-run tool.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...a: string[]
  ) => (page: Page) => Promise<unknown>;
  const result = await new AsyncFunction("page", code)(p);
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

export async function startServer(): Promise<void> {
  const server = new Server({ name: "website-mcp", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
  // A published tool is picked up by the next ListTools (dynamicTools re-reads the home), and the
  // notification tells clients that cache the list to refresh it.
  const session = new MintSession({
    onPublished: () => {
      void server.sendToolListChanged().catch(() => {});
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...fixedTools, ...dynamicTools()] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "open": {
          const p = await getPage();
          const resp = await p.goto(String(args.url), { waitUntil: "domcontentloaded", timeout: 30000 });
          return text({ url: p.url(), status: resp?.status() ?? null, title: await p.title() }, "open");
        }
        case "snapshot":
          return text(await ariaSnapshot(await getPage()), "snapshot");
        case "explore":
          return text(await exploreCode(await getPage(), String(args.code ?? "")), "explore");
        case "mint_effect":
          return text(session.setEffect(args.effect), "mint_effect");
        case "act":
          session.assertWrite("act");
          return text(await actCode(await getPage(), String(args.code ?? ""), args.dryRun !== false), "act");
        case "save_tool":
          return text(session.saveDraft(args.name, args.tool, args.source, args.signin), "save_tool");
        case "page_tabs":
          return text(await pageTabs(), "page_tabs");
        case "page_snapshot":
          return text(await pageSnapshot(args), "page_snapshot");
        case "page_explore":
          return text(await pageExplore(args), "page_explore");
        case "page_capture":
          return text(await pageCapture(args), "page_capture");
        case "save_cases":
          return text(session.saveCases(args.name, args.cases), "save_cases");
        case "test_tool": {
          const n = String(args.name);
          const run = args.which === "published" ? await session.testPublished(n) : await session.testDraft(n);
          return text(run, "test_tool");
        }
        case "guide":
          return text(readGuide(args.topic), "guide");
        case "submit_review":
          return text(session.submitReview(args.name, args.verdict, args.findings, args.sourceHash), "submit_review");
        case "publish_tool":
          return text(await session.publish(args.name), "publish_tool");
        case "list_tools":
          return text(
            listToolNames().map((n): Record<string, unknown> => {
              try {
                const m = readManifest(n) as unknown as Record<string, unknown>;
                return { name: n, description: m.description ?? "", version: m.version ?? 1, kind: m.kind ?? "browser" };
              } catch (e) {
                return { name: n, error: (e as Error).message };
              }
            }),
            "list_tools",
          );
        case "run_tool":
          return text(
            args.draft === true
              ? await session.runDraft(String(args.name), args.input ?? {})
              : await runTool(String(args.name), args.input ?? {}),
            "run_tool",
          );
        default:
          if (listToolNames().includes(name)) return text(await runTool(name, args), name);
          return text(toErrorPayload(new Error(`Unknown tool: ${name}`)), "error", true);
      }
    } catch (e) {
      return text(toErrorPayload(e), "error", true);
    }
  });

  const shutdown = async () => {
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}
