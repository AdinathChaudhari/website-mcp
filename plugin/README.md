# plugin/

The Claude Code plugin for website-mcp. Installed, it adds:

- `/website-mcp:mint <task> on <site>` (`skills/mint/SKILL.md`)
- the `website-mcp:website-mcp-reviewer` subagent (`agents/website-mcp-reviewer.md`, Sonnet, read-only tools)
- the `website-mcp` MCP server (`.mcp.json` -> `launch.mjs` -> `dist/cli.js serve`)

Install from a local checkout (the repo root is a marketplace, see `.claude-plugin/marketplace.json`):

```
npm install && npm run build
claude plugin marketplace add /path/to/website-mcp
claude plugin install website-mcp@website-mcp
```

A local-path marketplace loads this folder in place, so `launch.mjs` finds the build at `../dist`. A copied (git
or remote) install would not have `dist/`; see `docs/` notes or set `WEBSITE_MCP_ROOT` to a checkout. The
project-level `.claude/skills/mint` and `.claude/agents/website-mcp-reviewer.md` are symlinks to the files here,
so working inside this repo gives `/mint` with the same text.
