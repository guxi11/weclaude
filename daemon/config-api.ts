import type { Config } from "../shared/config.js";
import { patchJsonc } from "../shared/config-writer.js";

type Action = "set" | "add" | "remove";

type SetResult = { ok: true; key: string; before: unknown; after: unknown };
type SetError = { ok: false; reason: string };

const KEYS: Record<string, { path: string[]; type: "string" | "number" | "boolean" | "array"; enum?: readonly string[] }> = {
  allow_from:       { path: ["wrc", "allowFrom"],                type: "array" },
  approval_window:  { path: ["approval", "windowMinutes"],       type: "number" },
  approval_cache:   { path: ["approval", "sessionCacheMinutes"], type: "number" },
  danger_skip:      { path: ["approval", "danger", "skip"],      type: "boolean" },
  danger_skip_all:  { path: ["approval", "danger", "skipAll"],   type: "boolean" },
  danger_enabled:   { path: ["approval", "danger", "enabled"],   type: "boolean" },
  // 枚举必须校验: 写进 jsonc 的非法值会让 daemon reload 时 zod 抛错起不来。
  approval_mode:    { path: ["approval", "mode"],                type: "string", enum: ["all", "danger"] },
  cwd:              { path: ["wrc", "cwd"],                      type: "string" },
  default_chat:     { path: ["defaultChat"],                     type: "string" },
  log_level:        { path: ["daemon", "logLevel"],              type: "string" },
  slash_ack_first_line: { path: ["wrc", "mirror", "slashAckFirstLine"], type: "boolean" },
};

const getNestedValue = (obj: unknown, path: string[]): unknown =>
  path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);

const setNestedValue = (obj: unknown, path: string[], value: unknown): void => {
  const parent = path.slice(0, -1).reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  );
  if (parent && typeof parent === "object") {
    (parent as Record<string, unknown>)[path[path.length - 1]!] = value;
  }
};

const parseValue = (raw: string, type: string): unknown => {
  switch (type) {
    case "number": { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
    case "boolean": return raw === "true" || raw === "1";
    case "array": try { const a = JSON.parse(raw); return Array.isArray(a) ? a : undefined; } catch { return undefined; }
    default: return raw;
  }
};

export const configSet = (
  cfg: Config,
  sourcePath: string,
  key: string | undefined,
  value: unknown,
  action: string | undefined,
): SetResult | SetError => {
  if (!key || !KEYS[key]) return { ok: false, reason: `unknown key "${key}". valid: ${Object.keys(KEYS).join(", ")}` };
  const spec = KEYS[key]!;
  const act: Action = (action === "add" || action === "remove") ? action : "set";
  const before = getNestedValue(cfg, spec.path);

  if (spec.type === "array") {
    const arr = Array.isArray(before) ? (before as string[]).slice() : [];
    let after: string[];
    if (act === "add") {
      const item = String(value ?? "");
      if (!item) return { ok: false, reason: "value required for add" };
      after = arr.includes(item) ? arr : [...arr, item];
    } else if (act === "remove") {
      const item = String(value ?? "");
      if (!item) return { ok: false, reason: "value required for remove" };
      after = arr.filter((x) => x !== item);
    } else {
      const parsed = parseValue(String(value ?? "[]"), "array");
      if (!parsed) return { ok: false, reason: "value must be a JSON array for set on array keys" };
      after = parsed as string[];
    }
    patchJsonc(sourcePath, [{ path: spec.path, value: after }]);
    setNestedValue(cfg, spec.path, after);
    return { ok: true, key, before: arr, after };
  }

  const parsed = parseValue(String(value ?? ""), spec.type);
  if (parsed === undefined) return { ok: false, reason: `cannot parse "${value}" as ${spec.type}` };
  if (spec.enum && !spec.enum.includes(String(parsed))) {
    return { ok: false, reason: `invalid value "${parsed}". valid: ${spec.enum.join("|")}` };
  }
  patchJsonc(sourcePath, [{ path: spec.path, value: parsed }]);
  setNestedValue(cfg, spec.path, parsed);
  return { ok: true, key, before, after: parsed };
};

export const configGet = (cfg: Config, key: string | undefined): { ok: true; key: string; value: unknown } | SetError => {
  if (!key || !KEYS[key]) return { ok: false, reason: `unknown key "${key}". valid: ${Object.keys(KEYS).join(", ")}` };
  return { ok: true, key, value: getNestedValue(cfg, KEYS[key]!.path) };
};

export const CONFIG_KEYS = Object.keys(KEYS);
