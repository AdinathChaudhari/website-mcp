export default async ({ page, input, wm }) => {
  if (!input.q.trim()) throw new wm.InvalidInput("q must not be blank");
  await page.goto("__ORIGIN__/search?q=" + encodeURIComponent(input.q));
  return { items: await page.locator("ul.results li.item a.title").allTextContents() };
};
