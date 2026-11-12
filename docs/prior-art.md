# Prior art

Two projects shaped this one. Studying them produced ideas; the only code in this repo is original.

## Pomerado

[github.com/Pomerado/pomerado](https://github.com/Pomerado/pomerado), MIT.

Ideas taken: turning a website into saved, replayable tools with a model only at authoring time; a test bar before a tool counts as published; per-task authoring guides (search, pagination, forms, writes, testing) so the minting model gets targeted instructions.

Text: the guides in `authoring/` were written for this project. A check of `authoring/*.md` against Pomerado's authoring directory (line-level at 40+ characters, and shared runs of eight consecutive words) found no overlap, so no third-party text is included and `third-party/` carries no notice. If text is ever adapted closely, add its licence and a NOTICE under `third-party/pomerado/`.

## WebMCP

- [github.com/webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp), the web standard proposal for sites to expose tools to agents.
- [github.com/MiguelsPizza/WebMCP](https://github.com/MiguelsPizza/WebMCP), an implementation, AGPL.

Ideas only: tools described to an agent as typed functions, and the case for running them in the user's own browser session. No code, text or structure from either is in this repo, and none may be added: the second is AGPL and this project is MIT.

## How this project differs

Tools are minted by a model but saved as plain files and replayed with no model. Page tools run in the user's real tab through an extension, gated by a per-site grant and a per-version approval bound to the executed code.
