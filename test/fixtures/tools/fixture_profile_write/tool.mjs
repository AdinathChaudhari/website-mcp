export default async ({ page, input, wm }) => {
  if (!input.name.trim()) throw new wm.InvalidInput("name must not be blank");
  await page.goto("__ORIGIN__/form?delay=" + (input.delayMs ?? 0));
  await page.fill("#name", input.name);
  await wm.commit("save_profile", async () => {
    await page.click("#save");
    await page.waitForSelector(".saved");
  });
  return { filled: input.name };
};
