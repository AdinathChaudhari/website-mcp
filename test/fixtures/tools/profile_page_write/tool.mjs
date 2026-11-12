export default async ({ input, wm }) => {
  wm.fill("#name", input.name);
  const r = await wm.handOff({ prompt: "Check the name, then press Save.", until: ".saved", timeoutSec: input.waitSec ?? 5 });
  return { committed: r.committed };
};
