import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** <repo>/authoring, found relative to this file (dist/server/ or src/server/), so it works from any cwd. */
export function guidesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "authoring");
}

/** Topics = the .md file names in authoring/ (README excluded), sorted. */
export function guideTopics(): string[] {
  const dir = guidesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((f) => f.slice(0, -3))
    .sort();
}

/** The guide's text, or the list of topics when `topic` is missing or unknown. Only listed topics are ever read. */
export function readGuide(topic: unknown): { topic: string; text: string } | { unknownTopic: string | null; topics: string[] } {
  const topics = guideTopics();
  if (typeof topic === "string" && topics.includes(topic)) return { topic, text: readFileSync(join(guidesDir(), `${topic}.md`), "utf8") };
  return { unknownTopic: typeof topic === "string" ? topic : null, topics };
}
