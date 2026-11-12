import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ariaSnapshot, capResult } from "../browser/snapshot.js";
import { toErrorPayload } from "../runtime/errors.js";
import { MintSession, RESERVED_NAMES } from "../mint/session.js";
import { listToolNames, readManifest } from "../runtime/load.js";
import { readGuide } from "./guides.js";
import { runTool } from "../runtime/run.js";

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
    name: "save_tool",
    description:
      "Save a DRAFT tool (it is not callable as a tool until published). `tool` is the tool.json object (description, input, output JSON Schemas, effect \"read\", kind default \"browser\", site.allowedOrigins, optional resultsPath = dot path to the output's main list). `source` is the tool.mjs text with a default export `async ({ page, input, wm }) => result`. Next: save_cases, test_tool, the website-mcp-reviewer subagent, submit_review, publish_tool.",
    inputSchema: obj(
      {
        name: { type: "string", description: "^[a-z][a-z0-9_]{1,62}$" },
        tool: { type: "object" },
        source: { type: "string" },
      },
      ["name", "tool", "source"],
    ),
  },
  {
    name: "save_cases",
    description:
      'Save the draft\'s test cases: an array of { name, purpose, input, expect }. expect is "result" (succeeds, main list non-empty), "empty" (succeeds, main list empty) or "invalid_input" (tool rejects the input). Publishing needs at least 3.',
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
      "Publish a draft as a callable tool. Refuses without an allow review whose sourceHash matches the current draft (see submit_review), and (with reasons naming failing cases) below 70% pass or under 3 cases, on schema errors, literal URLs outside site.allowedOrigins (a text heuristic: the runtime route guard is the real enforcement), or secret-shaped literals. The draft is copied first and the cases always run on that copy unless this session just tested the same files. Keeps the previous version in .history/<n>/.",
    inputSchema: obj({ name: { type: "string" } }, ["name"]),
  },
  {
    name: "guide",
    description:
      "Minting guidance. topic is one of the authoring guides (core, testing, pagination, search, publication); read core first, and the others when the task involves them. An unknown or missing topic returns the list of topics.",
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
  },
];

function dynamicTools() {
  const out: { name: string; description: string; inputSchema: object }[] = [];
  for (const n of listToolNames()) {
    if (FIXED.includes(n)) continue;
    try {
      const m = readManifest(n);
      if ((m.input as { type?: unknown }).type !== "object") continue;
      out.push({ name: n, description: m.description ?? `Saved tool ${n}`, inputSchema: m.input });
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
        case "save_tool":
          return text(session.saveDraft(args.name, args.tool, args.source), "save_tool");
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
