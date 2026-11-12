import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, startMcp, tempHome, rm } from "../helpers/index.mjs";

const { guideTopics, readGuide } = await import("../../dist/server/guides.js");
const home = tempHome("wm-unit-guides-");
after(() => rm(home));

const TOPICS = ["core", "hard-targets", "page-tools", "pagination", "publication", "search", "testing"];

test("topics are the authoring/*.md file names, README excluded", () => {
  assert.deepEqual(guideTopics(), TOPICS);
  const onDisk = readdirSync(join(ROOT, "authoring")).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(guideTopics(), onDisk);
});

test("readGuide returns the file text for a known topic", () => {
  const g = readGuide("core");
  assert.equal(g.topic, "core");
  assert.equal(g.text, readFileSync(join(ROOT, "authoring", "core.md"), "utf8"));
});

test("the Phase 1 lesson is in the core guide: check locator.count() before reading maybe-absent elements", () => {
  assert.match(readGuide("core").text, /count\(\)/);
  assert.match(readGuide("core").text, /30 seconds/);
});

test("an unknown, missing or path-like topic returns the topic list and reads no file", () => {
  assert.deepEqual(readGuide("nope"), { unknownTopic: "nope", topics: TOPICS });
  assert.deepEqual(readGuide(undefined), { unknownTopic: null, topics: TOPICS });
  assert.deepEqual(readGuide("../package"), { unknownTopic: "../package", topics: TOPICS });
  assert.deepEqual(readGuide("README"), { unknownTopic: "README", topics: TOPICS });
});

test("guide over MCP: known topic returns text, unknown lists topics, tool is advertised", async () => {
  const mcp = await startMcp(home);
  try {
    assert.ok((await mcp.client.listTools()).tools.some((t) => t.name === "guide"));
    assert.ok((await mcp.client.listTools()).tools.some((t) => t.name === "submit_review"));
    const ok = await mcp.call("guide", { topic: "pagination" });
    assert.equal(ok.isError, false);
    assert.equal(ok.v.topic, "pagination");
    assert.match(ok.v.text, /wm\.paginate/);
    const bad = await mcp.call("guide", { topic: "zzz" });
    assert.equal(bad.isError, false);
    assert.deepEqual(bad.v.topics, TOPICS);
    assert.deepEqual((await mcp.call("guide", {})).v.topics, TOPICS);
  } finally {
    await mcp.close();
  }
});

test("every guide the skill names exists", () => {
  const skill = readFileSync(join(ROOT, "plugin", "skills", "mint", "SKILL.md"), "utf8");
  for (const t of ["core", "pagination", "search", "testing"]) {
    assert.ok(skill.includes("`" + t + "`"), `skill mentions ${t}`);
    assert.ok(guideTopics().includes(t));
  }
});
