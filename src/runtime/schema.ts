import { Ajv } from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

export interface Validation {
  ok: boolean;
  errors: string;
}

export function validate(schema: unknown, data: unknown): Validation {
  const fn = ajv.compile(schema as object);
  const ok = fn(data) as boolean;
  if (ok) return { ok, errors: "" };
  const errors = (fn.errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
    .join("; ");
  return { ok, errors };
}

/** Throws if the schema itself is not a valid JSON Schema. */
export function assertSchema(schema: unknown, label: string): void {
  try {
    ajv.compile(schema as object);
  } catch (e) {
    throw new Error(`${label} is not a valid JSON Schema: ${(e as Error).message}`);
  }
}
