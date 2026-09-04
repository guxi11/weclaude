// Persisted mirror attachments: principal (e.g. "chat:xxx" / "user:xxx") →
// { sessionId, jsonlPath, tmuxSession?, tmuxPane? }. Survives daemon reload so
// the next inbound for a known chat resumes the prior Claude session instead
// of spawning a fresh one. Single-file write-through, same shape/style as
// sessions.ts.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { expandHome } from "../shared/paths.js";

export interface MirrorAttachment {
  sessionId: string;
  jsonlPath: string;
  tmuxSession?: string;
  /** Snapshot at attach time. Pane ids are not stable across daemon restarts;
   * restore re-derives the live pane from `tmuxSession` via `list-panes`. */
  tmuxPane?: string;
  /** Project cwd the live pane was last spawned in. Empty/undefined → fall
   *  back to cfg.wrc.cwd. Updated on every spawn/respawn so /pwd reflects
   *  reality, not an outdated user request. */
  cwd?: string;
  /** User-requested next cwd (set by AI via the `set_workspace` MCP). Applied
   *  on the next /new (or /clear → upgraded to /new when present). Cleared
   *  once the spawn lands. Decoupling from `cwd` means a /pwd before /new
   *  can show "current X, will switch to Y on /new". */
  pendingCwd?: string;
  /** `/stop` keepalive pause, persisted so a daemon reload doesn't resurrect a
   *  session the user explicitly quieted. Lifted (→ false) by a real inbound or a
   *  busy-resume, both of which re-persist. `keepaliveOffAt` = when paused (ms),
   *  gating the busy-resume grace across restarts. */
  keepaliveOff?: boolean;
  keepaliveOffAt?: number;
}

export interface MirrorStore {
  get: (principal: string) => MirrorAttachment | undefined;
  set: (principal: string, rec: MirrorAttachment) => void;
  drop: (principal: string) => void;
  all: () => Record<string, MirrorAttachment>;
}

export const loadMirrorStore = (filePath: string): MirrorStore => {
  const abs = expandHome(filePath);
  let map: Record<string, MirrorAttachment> = {};
  if (existsSync(abs)) {
    try {
      map = JSON.parse(readFileSync(abs, "utf8")) as Record<string, MirrorAttachment>;
    } catch {
      map = {};
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
  }
  const persist = (): void => {
    writeFileSync(abs, JSON.stringify(map, null, 2), "utf8");
  };
  return {
    get: (p) => map[p],
    set: (p, rec) => {
      map[p] = rec;
      persist();
    },
    drop: (p) => {
      delete map[p];
      persist();
    },
    all: () => ({ ...map }),
  };
};
