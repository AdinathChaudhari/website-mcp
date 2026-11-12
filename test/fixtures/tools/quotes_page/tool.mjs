// Page tool: runs inside the user's open tab. Self-contained; no imports, no closures.
export default async ({ input, wm }) => {
  const quotes = [...document.querySelectorAll(".quote")].map((q) => ({
    text: q.querySelector(".text")?.textContent?.trim() ?? "",
    author: q.querySelector(".author")?.textContent?.trim() ?? "",
  }));
  return { quotes };
};
