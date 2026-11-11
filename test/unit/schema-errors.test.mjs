import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, assertSchema } from "../../dist/runtime/schema.js";
import { InvalidInput, InvalidOutput, ToolFailed, Timeout, ToolNotFound, PublishRefused, WebsiteMcpError, toErrorPayload } from "../../dist/runtime/errors.js";
import { makeHelper } from "../../dist/runtime/runners/playwright.js";

const schema = { type: "object", properties: { q: { type: "string", minLength: 1 } }, required: ["q"], additionalProperties: false };

test("validate accepts good data and reports bad data", () => {
  assert.equal(validate(schema, { q: "x" }).ok, true);
  const bad = validate(schema, { q: "" });
  assert.equal(bad.ok, false);
  assert.match(String(bad.errors), /q/);
  assert.equal(validate(schema, { q: "x", extra: 1 }).ok, false);
});

test("assertSchema throws on an invalid schema", () => {
  assert.throws(() => assertSchema({ type: "nonsense" }, "x"));
  assert.doesNotThrow(() => assertSchema(schema, "x"));
});

test("error classes carry the documented codes and JSON payloads", () => {
  const cases = [
    [new ToolNotFound("a"), "tool_not_found"],
    [new InvalidInput("m"), "invalid_input"],
    [new InvalidOutput("m"), "invalid_output"],
    [new ToolFailed("m"), "tool_failed"],
    [new Timeout(3), "timeout"],
    [new PublishRefused("m", [{ code: "x" }]), "publish_refused"],
  ];
  for (const [e, code] of cases) {
    assert.ok(e instanceof WebsiteMcpError);
    assert.equal(e.code, code);
    assert.equal(toErrorPayload(e).error.code, code);
  }
  assert.deepEqual(toErrorPayload(new PublishRefused("m", [{ code: "x" }])).error.reasons, [{ code: "x" }]);
  assert.equal(toErrorPayload(new Error("boom")).error.code, "tool_failed");
});

test("wm exposes InvalidInput and log", () => {
  const wm = makeHelper();
  assert.equal(wm.InvalidInput, InvalidInput);
  assert.equal(typeof wm.log, "function");
});
