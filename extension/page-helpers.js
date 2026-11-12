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
  };
  return wm;
})()
