// In-page helpers (`wm`). A single expression: the service worker injects its text as `const wm = <this file>;`
// and the Node side reads it with readPageHelpers(). Keep it self-contained.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Write tools: the runner arms this once with the runtime's dryRun; the tool cannot re-arm it or set `saved` itself.
  let armed = false, dry = true, saved = false;
  const wm = {
    _arm(d) { if (!armed) { armed = true; dry = d !== false; } },
    committed: () => saved,
    /** Type a value into a field (native setter + input/change events). Never clicks or submits. */
    fill(selector, value) {
      const el = document.querySelector(selector);
      if (!el) throw new Error("fill: no element for " + selector);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    /** Ask the user to press Save themselves. Waits for `until` (a selector that appears once saved), up to timeoutSec. Never clicks. dryRun: returns at once. */
    async handOff({ prompt, until, timeoutSec = 120 }) {
      if (dry) return { committed: false, dryRun: true };
      if (typeof until !== "string" || !until) throw new Error("handOff needs `until`: a selector that appears once the user has saved");
      if (document.querySelector(until)) throw new Error("handOff: `until` already matches before the user saved; use a selector that appears only after Save");
      const bar = document.createElement("div");
      bar.textContent = String(prompt || "Review the form, then save it yourself.");
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px;background:#fde68a;color:#111;font:14px sans-serif;text-align:center";
      document.body.appendChild(bar);
      const end = Date.now() + Math.min(Number(timeoutSec) || 120, 900) * 1000;
      try {
        while (Date.now() < end) {
          if (document.querySelector(until)) return { committed: (saved = true) };
          await sleep(250);
        }
        return { committed: false, possibleCommit: false, timedOut: true, reason: "timed out waiting for the user to save" };
      } finally { bar.remove(); }
    },
    async waitFor(selector, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const el = document.querySelector(selector);
        if (el) return el;
        await sleep(50);
      }
      throw new Error(`waitFor timed out after ${timeoutMs} ms: ${selector}`);
    },
    text(selector) {
      const el = document.querySelector(selector);
      return el ? (el.textContent || "").trim() : null;
    },
    all(selector, mapFn) {
      const els = [...document.querySelectorAll(selector)];
      return mapFn ? els.map(mapFn) : els;
    },
    scrollIntoView(selector) {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      return true;
    },
    /** Why the page looks like a bot check / block, or null. Generic signals only: whole path segments, captcha frames, title and h1. */
    challenge() {
      const heads = [document.title, ...[...document.querySelectorAll("h1")].map((e) => e.textContent || "")];
      // Only a visible, sizeable widget counts: an invisible reCAPTCHA v3 badge or a 0x0 anchor frame is not a challenge.
      const shown = (e) => { try { const r = e.getBoundingClientRect ? e.getBoundingClientRect() : { width: 100, height: 100 }; if (r.width < 50 || r.height < 50) return false; const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false; return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; } catch (x) { return true; } };
      const frame = [...document.querySelectorAll("iframe")].find((f) => /captcha|turnstile|challenges\.cloudflare/i.test(f.src || "") && shown(f));
      if (/(^|\/)(checkpoint|captcha|security-check|authwall|sorry)(\/|$)/i.test(location.pathname)) return "challenge page path " + location.pathname;
      const widget = document.querySelector(".g-recaptcha,.h-captcha,.cf-turnstile");
      if (frame || (widget && shown(widget))) return "captcha on the page";
      // Phrases must open a short title or h1 (a long article heading that merely mentions one is not a block page).
      const bad = heads.map((t) => t.trim()).find((t) => t.length <= 80 && (/^((let.s|please) )?verify (that )?you(.re| are) (a )?(human|not a robot)|^are you a (robot|human)|^unusual traffic|^security check\b|^too many requests\b|^request denied\b/i.test(t) || /^(http |error )?(429|999)([^\w]*$|\s+(too many|request|error|denied|blocked))/i.test(t)));
      return bad ? "page says: " + bad.slice(0, 60) : null;
    },
    /** Human-paced scroll to load lazy sections. Bounded (<=50 steps), 150 ms+ pauses with jitter, stops after two steps with no new height, and stops at once on a challenge. */
    async scrollToLoad({ maxSteps = 10, pauseMs = 800 } = {}) {
      const steps = Math.max(1, Math.min(50, Math.floor(maxSteps) || 1));
      const pause = Math.max(200, Math.min(5000, Number(pauseMs) || 800));
      let done = 0, quiet = 0, last = document.documentElement.scrollHeight;
      while (done < steps && quiet < 2) {
        scrollBy(0, Math.round(innerHeight * (0.6 + Math.random() * 0.3)));
        done++;
        await sleep(pause * (0.75 + Math.random() * 0.5));
        const why = wm.challenge();
        if (why) throw new Error("challenge: " + why);
        const h = document.documentElement.scrollHeight;
        // A quiet step only counts at the real bottom: a page still above it may have more to load.
        quiet = h > last ? 0 : scrollY + innerHeight >= h - 1 ? quiet + 1 : quiet;
        last = h;
      }
      return { steps: done, height: last };
    },
  };
  return Object.freeze(wm); // tool code must not be able to replace wm.challenge
})()
