import { main } from "./host.js";

main().catch((e) => {
  process.stderr.write(`website-mcp bridge host failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
