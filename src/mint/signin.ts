import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Signin {
  /** CSS selector that exists in the tab only while the user is signed in. */
  marker: string;
  /** Where the user signs in; named in the SIGNED_OUT error. Must be inside site.allowedOrigins. */
  loginUrl: string;
}

/** Problems with a parsed signin.json value (empty = valid). */
export function signinProblems(v: unknown, allowedOrigins: string[]): string[] {
  const out: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["signin.json must be an object { marker, loginUrl }"];
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "marker" && k !== "loginUrl") out.push(`signin.json: unknown field "${k}"`);
  if (typeof o.marker !== "string" || !o.marker.trim() || o.marker.length > 200) out.push("signin.json: marker must be a CSS selector string (max 200 chars)");
  else if (/[{}]|<\/?script/i.test(o.marker)) out.push("signin.json: marker must be a plain CSS selector");
  try {
    const u = new URL(String(o.loginUrl));
    if (u.protocol !== "https:" && u.protocol !== "http:") out.push("signin.json: loginUrl must be http(s)");
    else if (!allowedOrigins.includes(u.origin)) out.push(`signin.json: loginUrl origin ${u.origin} is not in site.allowedOrigins`);
  } catch {
    out.push("signin.json: loginUrl must be a URL");
  }
  return out;
}

/** <dir>/signin.json, or undefined when absent. Throws when present but malformed (fail closed at run time). */
export function readSignin(dir: string): Signin | undefined {
  const f = join(dir, "signin.json");
  if (!existsSync(f)) return undefined;
  let o: Partial<Signin>;
  try {
    o = JSON.parse(readFileSync(f, "utf8")) as Partial<Signin>;
  } catch {
    throw new Error("signin.json is not valid JSON; refusing to run");
  }
  if (typeof o?.marker !== "string" || !o.marker || typeof o.loginUrl !== "string") throw new Error("signin.json needs { marker, loginUrl }; refusing to run");
  return { marker: o.marker, loginUrl: o.loginUrl };
}
