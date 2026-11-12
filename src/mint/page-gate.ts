/**
 * Static gate for page-tool source (kind "page"). A conservative token scan, NOT a parser: it runs at publish time
 * where no new runtime dependency is allowed. Real enforcement is the tab itself (the extension's per-version approval,
 * the USER_SCRIPT world, the allowed-origin grants); this catches the honest mistakes and the lazy tricks early.
 *
 * Limits (also in authoring/page-tools.md):
 *  - Strings, comments and regex literals are blanked first, so a forbidden word inside text is fine, and a word
 *    assembled from pieces ("fe" + "tch") is NOT seen. We refuse the usual way to reach it (computed access on window /
 *    globalThis / self / top / parent, and `constructor`) but a determined author can still get round a text scan.
 *  - "No free variables" is approximate. We refuse any top-level statement besides the single default export, so a
 *    module-level helper cannot be closed over, and inside the function we compare every identifier against the names
 *    declared anywhere in it (scope-blind: a name declared in one block masks a free use in another) and a list of
 *    safe globals. Unusual syntax (labels, `with`, getters named like globals) can give a false positive or negative.
 *  - Regex-vs-division after `)` or `}` is guessed as division.
 */

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

/** Source with comments, string contents and regex literals replaced by spaces. Template `${ ... }` expressions stay as code. Same length as the input. */
export function codeOnly(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  // Stack of template-literal brace depths: when a `}` closes `${`, return to template-string mode.
  const tpl: number[] = [];
  let depth = 0;
  let lastSig = "\n"; // last non-space char of real code
  let lastWord = "";
  const readTemplate = (): void => {
    // positioned just after an opening ` or the } that closes ${...}; blank text until ${ or closing `
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        out.push(" ", i + 1 < n ? blank(src[i + 1]) : " ");
        i += 2;
        continue;
      }
      if (ch === "`") {
        out.push(" ");
        i++;
        return;
      }
      if (ch === "$" && src[i + 1] === "{") {
        out.push(" ", "{");
        i += 2;
        tpl.push(depth);
        depth++;
        lastSig = "{";
        return;
      }
      out.push(blank(ch));
      i++;
    }
  };
  while (i < n) {
    const ch = src[i];
    const nx = src[i + 1];
    if (ch === "/" && nx === "/") {
      while (i < n && src[i] !== "\n") out.push(" "), i++;
      continue;
    }
    if (ch === "/" && nx === "*") {
      out.push(" ", " ");
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) out.push(blank(src[i])), i++;
      if (i < n) out.push(" ", " "), (i += 2);
      continue;
    }
    if (ch === '"' || ch === "'") {
      out.push(ch); // keep the quotes so structure ("a": 1) stays visible
      i++;
      while (i < n && src[i] !== ch && src[i] !== "\n") {
        if (src[i] === "\\") out.push(" "), i++;
        if (i < n) out.push(blank(src[i])), i++;
      }
      if (i < n && src[i] === ch) out.push(ch), i++;
      lastSig = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`") {
      out.push("`");
      i++;
      readTemplate();
      lastSig = "`";
      lastWord = "";
      continue;
    }
    if (ch === "/") {
      const regexOk = REGEX_BEFORE.has(lastSig) || KEYWORDS_BEFORE_REGEX.has(lastWord);
      if (regexOk) {
        out.push(" ");
        i++;
        let cls = false;
        while (i < n && src[i] !== "\n" && (cls || src[i] !== "/")) {
          if (src[i] === "\\") out.push(" "), i++;
          else if (src[i] === "[") cls = true;
          else if (src[i] === "]") cls = false;
          if (i < n) out.push(blank(src[i])), i++;
        }
        if (i < n && src[i] === "/") out.push(" "), i++;
        while (i < n && /[a-z]/i.test(src[i])) out.push(" "), i++; // flags
        lastSig = "a";
        lastWord = "";
        continue;
      }
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop();
        out.push(" ");
        i++;
        readTemplate();
        continue;
      }
    }
    out.push(ch);
    i++;
    if (!/\s/.test(ch)) {
      lastSig = ch;
      if (/[\w$]/.test(ch)) {
        let j = out.length - 1;
        let w = "";
        while (j >= 0 && /[\w$]/.test(out[j])) w = out[j--] + w;
        lastWord = w;
      } else lastWord = "";
    }
  }
  return out.join("");
}

/** Forbidden constructs: [label, regex over codeOnly text]. */
const FORBIDDEN: [string, RegExp][] = [
  ["fetch", /(?<![.\w$])fetch\b(?!\s*:)|\b(?:window|globalThis|self)\s*\.\s*fetch\b/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["eval", /(?<![.\w$])eval\b(?!\s*:)|\b(?:window|globalThis|self)\s*\.\s*eval\b/],
  ["new Function / Function()", /\bnew\s+Function\b|(?<![.\w$])Function\s*\(/],
  ["importScripts", /\bimportScripts\b/],
  ["chrome.*", /(?<![\w$])chrome\s*[.[]|\bbrowser\s*\.\s*(?:runtime|tabs|storage|cookies)\b/],
  ["document.cookie", /\bdocument\s*\.\s*cookie\b|\bcookieStore\b/],
  ["localStorage/sessionStorage write", /\b(?:localStorage|sessionStorage)\s*(?:\.\s*(?:setItem|removeItem|clear)\b|\[[^\]]*\]\s*=(?!=)|\.\s*[\w$]+\s*=(?!=))/],
  ["indexedDB", /\bindexedDB\b/],
  ["Worker / SharedWorker", /\b(?:Shared)?Worker\s*\(/],
  ["dynamic global lookup (window[...], globalThis[...])", /\b(?:window|globalThis|self|top|parent|frames|defaultView|navigator)\s*\[/],
  ["computed member with a built-up string key", /[\w$)\]]\s*\[[^\]\n]*(?:["'`]\s*\+|\+\s*["'`])[^\]\n]*\]/],
  ["setTimeout/setInterval with a non-function first argument", /\b(?:setTimeout|setInterval)\s*\(\s*(?!(?:async\b|function\b|\([^)]*\)\s*=>|[\w$]+\s*=>|[A-Za-z_$][\w$]*\s*[,)]))/],
  ["globalThis", /\bglobalThis\b/],
  ["constructor (Function-constructor escape)", /\.\s*constructor\b|\bconstructor\s*\./],
  ["import / require", /(?<![.\w$])(?:import|require)\s*(?:\(|[\w${*"'])/],
  ["location writes / navigation", /\b(?:window\s*\.\s*)?location\s*(?:\.\s*(?:assign|replace|href|pathname|search|hash)\s*=(?!=)|=(?!=)|\.\s*(?:assign|replace)\s*\()/],
  ["window.open", /\bwindow\s*\.\s*open\s*\(|(?<![.\w$])open\s*\(\s*["'`]/],
];

/** Extra rules for page tools with effect "write": never press the final control. */
const WRITE_FORBIDDEN: [string, RegExp][] = [
  ["click() / submit() / requestSubmit() (the user presses Save, never the tool)", /\.\s*(?:click|submit|requestSubmit)\s*(?:\?\.\s*)?\(/],
  ["the names click / submit / requestSubmit (no aliasing, destructuring or .call)", /(?<![\w$])(?<!wm\s*\.\s*)(?:click|submit|requestSubmit)(?![\w$])/],
  [".prototype access", /\.\s*prototype\b/],
  ["dispatchEvent (use wm.fill to set values; never synthesise a click or submit)", /\bdispatchEvent\b/],
];
/** Computed member access with a string-literal key, checked on the raw source (codeOnly blanks the key): `el["click"]()`. */
const WRITE_COMPUTED_KEY = /(?:[)\]]|(?<![\w$])(?!(?:of|in|return|typeof|case|yield|await|void|delete|else|do|throw|new)(?![\w$]))[\w$]+)\s*\[\s*["'`]/g;

/** True when a computed string-key access sits in real code: its `[` survives in codeOnly (not inside a comment or string literal). codeOnly keeps length, so indices line up. */
function hasComputedKey(source: string, code: string): boolean {
  for (const m of source.matchAll(WRITE_COMPUTED_KEY)) if (code[m.index + m[0].indexOf("[")] === "[") return true;
  return false;
}

const KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield await async get set null true false undefined arguments".split(" "),
);

/** Globals a page tool may read. Everything else must be declared inside the function. */
const SAFE_GLOBALS = new Set(
  (
    "Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Map Set WeakMap WeakSet Promise Error TypeError RangeError SyntaxError EvalError ReferenceError Intl " +
    "parseInt parseFloat isNaN isFinite NaN Infinity encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape structuredClone atob btoa queueMicrotask " +
    "URL URLSearchParams TextDecoder TextEncoder console performance " +
    "document window location navigator history getComputedStyle matchMedia setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame " +
    "Node NodeFilter Element HTMLElement HTMLInputElement HTMLAnchorElement HTMLImageElement HTMLFormElement HTMLTableElement HTMLSelectElement HTMLTextAreaElement " +
    "DOMParser XPathResult Event CustomEvent"
  ).split(" "),
);

const IDENT = /[A-Za-z_$][\w$]*/g;

/** Identifiers in a binding pattern or parameter list (over-approximate: includes property keys). */
function names(text: string): string[] {
  return text.match(IDENT) ?? [];
}

/** Index just past the bracket that closes the one opening at `open`. */
function closeOf(s: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let d = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") {
      d--;
      if (d === 0) return pairs[s[open]] === c ? i + 1 : -1;
    }
  }
  return -1;
}

export interface PageGateReport {
  problems: string[];
  /** Forbidden constructs found (labels), for tests and messages. */
  forbidden: string[];
  /** Names used but not declared (free variables). */
  free: string[];
}

/** Check a page tool's tool.mjs text. Empty `problems` = passes the static gate. */
export function scanPageSource(source: string, opts: { write?: boolean } = {}): PageGateReport {
  const problems: string[] = [];
  const code = codeOnly(source);
  const forbidden: string[] = [];
  for (const [label, re] of FORBIDDEN) if (re.test(code)) forbidden.push(label);
  // A write tool fills the form and hands the final control to the user. Best-effort static scan (JavaScript can always be obfuscated further); the reviewer is the second layer, the user's own Save is the boundary.
  if (opts.write) {
    for (const [label, re] of WRITE_FORBIDDEN) if (re.test(code)) forbidden.push(label);
    if (hasComputedKey(source, code)) forbidden.push('computed member access with a string-literal key (write the property name with a dot)');
  }
  if (forbidden.length) problems.push(`forbidden in a page tool: ${forbidden.join(", ")}`);

  // Shape: nothing but one `export default <function>` (a closure over a module-level name is impossible then).
  const m = /\bexport\s+default\b/.exec(code);
  if (!m) return { problems: [...problems, "tool.mjs needs a default export"], forbidden, free: [] };
  const before = code.slice(0, m.index).trim();
  if (before) problems.push("a page tool is the default export and nothing else: no top-level statements, helpers or constants before it (they would be closed over, and the tab only receives the function)");
  if (/\bexport\b/.test(code.slice(m.index + m[0].length))) problems.push("only one export is allowed (the default export)");
  const fn = code.slice(m.index + m[0].length);

  // Anything after the function at bracket depth 0 other than a closing `;` is a second statement.
  let d = 0;
  for (let i = 0; i < fn.length; i++) {
    const c = fn[i];
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (c === ";" && d === 0 && fn.slice(i + 1).trim()) {
      problems.push("extra code after the default export function (only the function may be exported)");
      break;
    }
  }

  // The first parameter may only destructure { input, wm }.
  const head = /^\s*(?:async\s+)?(?:function\b\s*[\w$]*\s*)?(\()/.exec(fn);
  let paramNames: string[] = [];
  if (head) {
    const open = fn.indexOf("(", head.index);
    const close = closeOf(fn, open);
    if (close > 0) {
      const params = fn.slice(open + 1, close - 1).trim();
      paramNames = names(params);
      const m2 = /^\{([^{}]*)\}(?:\s*=\s*\{\s*\})?$/.exec(params);
      if (params && !m2) problems.push("the function takes one destructured argument { input, wm }; nothing else is passed in");
      else if (m2) {
        const bad: string[] = [];
        for (const part of m2[1].split(",")) {
          const key = /^\s*([A-Za-z_$][\w$]*)\s*(?::|=|$)/.exec(part)?.[1];
          if (part.trim() && key !== "input" && key !== "wm") bad.push(part.trim().split(/[:=\s]/)[0] || part.trim());
        }
        if (bad.length) problems.push(`the function receives only { input, wm }, not: ${[...new Set(bad)].join(", ")}`);
      }
    }
  } else if (!/^\s*(?:async\s+)?(?:function\b|[\w$]+\s*=>)/.test(fn)) {
    problems.push("the default export must be a function (async ({ input, wm }) => ...)");
  }

  // Free variables.
  const declared = new Set<string>(["input", "wm", ...paramNames]);
  for (const x of fn.matchAll(/\b(?:const|let|var)\s+([^=;]*?)(?==|;|\bof\b|\bin\b|$)/gm)) for (const nme of names(x[1])) declared.add(nme);
  for (const x of fn.matchAll(/\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g)) declared.add(x[1]);
  for (const x of fn.matchAll(/\bcatch\s*\(([^)]*)\)/g)) for (const nme of names(x[1])) declared.add(nme);
  for (const x of fn.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) for (const nme of names(x[1])) declared.add(nme);
  for (const x of fn.matchAll(/(?<![\w$])\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*=>/g)) for (const nme of names(x[1])) declared.add(nme);
  for (const x of fn.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(x[1]);
  // destructuring declarations: const { a, b: c } = ..., const [x, y] = ...
  for (const x of fn.matchAll(/\b(?:const|let|var)\s*([{[])/g)) {
    const open = x.index! + x[0].length - 1;
    const close = closeOf(fn, open);
    if (close > 0) for (const nme of names(fn.slice(open, close))) declared.add(nme);
  }
  // for (const x of ...) / for (x of ...)
  const free = new Set<string>();
  for (const x of fn.matchAll(IDENT)) {
    const id = x[0];
    const at = x.index!;
    if (KEYWORDS.has(id) || declared.has(id) || SAFE_GLOBALS.has(id)) continue;
    const prev = fn.slice(0, at).trimEnd();
    if (prev.endsWith(".") || prev.endsWith("?.")) continue; // a member, not a variable
    const next = fn.slice(at + id.length).trimStart();
    if (next.startsWith(":") && /[{,]$/.test(prev)) continue; // object key
    if (/^\d/.test(fn[at - 1] ?? "")) continue; // e.g. 1e3
    free.add(id);
  }
  const freeList = [...free];
  if (freeList.length) problems.push(`free variable(s) ${freeList.slice(0, 6).join(", ")}: a page tool is serialised and runs inside the tab, so it can only use { input, wm }, the page's own globals and what it declares itself`);
  return { problems, forbidden, free: freeList };
}
