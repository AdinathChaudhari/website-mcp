// In-page helpers (`wm`). A single expression: the service worker injects its text as `const wm = <this file>;`
// and the Node side reads it with readPageHelpers(). Keep it self-contained.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wm = {
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
      const frame = [...document.querySelectorAll("iframe")].find((f) => /captcha|turnstile|challenges\.cloudflare/i.test(f.src || ""));
      if (/(^|\/)(checkpoint|captcha|security-check|authwall|sorry)(\/|$)/i.test(location.pathname)) return "challenge page path " + location.pathname;
      if (frame || document.querySelector(".g-recaptcha,.h-captcha,.cf-turnstile")) return "captcha on the page";
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
