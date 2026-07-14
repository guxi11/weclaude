// Wraps @wecom/aibot-node-sdk WSClient. Pure construction + event wiring;
// outbound helpers (text/card) live in `outbound.ts`.
import {
  WSClient,
  WSAuthFailureError,
  WSReconnectExhaustedError,
  type Logger as SdkLogger,
} from "@wecom/aibot-node-sdk";
// https-proxy-agent@5 is CommonJS: a factory function is the default export.
// Under Node ESM the named `{ HttpsProxyAgent }` import fails at runtime, so
// import the factory and call it.
import createHttpsProxyAgent from "https-proxy-agent";
import type { Logger } from "pino";
import type { Config } from "../shared/config.js";

// SCENE is a numeric channel tag assigned by WeCom for telemetry;
// 0 = generic / unbranded.
const SCENE = 0;
const PLUG_VERSION = "0.0.1";
const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT = 10;
const MAX_AUTH_FAIL = 5;

const sdkLogger = (log: Logger): SdkLogger => ({
  debug: (msg, ...a) => log.debug({ a }, String(msg)),
  info: (msg, ...a) => log.info({ a }, String(msg)),
  warn: (msg, ...a) => log.warn({ a }, String(msg)),
  error: (msg, ...a) => log.error({ a }, String(msg)),
});

// Config `bot.proxy` wins over env; the `ws` lib ignores HTTPS_PROXY so we read
// it ourselves and hand the SDK an explicit agent. Empty → no proxy (direct).
const resolveProxy = (bot: Config["bot"]): string =>
  bot.proxy || process.env.HTTPS_PROXY || process.env.https_proxy || "";

export interface DaemonWs {
  client: WSClient;
  /** resolves on first authenticated; rejects on fatal auth/reconnect failure */
  ready: Promise<void>;
  shutdown: () => Promise<void>;
}

export const startWs = (cfg: Config, log: Logger): DaemonWs => {
  const { bot } = cfg;
  const proxy = resolveProxy(bot);
  log.info({ botId: bot.botId, ws: bot.websocketUrl, proxy: proxy || undefined }, "WS init");

  const client = new WSClient({
    botId: bot.botId,
    secret: bot.secret,
    wsUrl: bot.websocketUrl,
    logger: sdkLogger(log),
    heartbeatInterval: HEARTBEAT_MS,
    maxReconnectAttempts: MAX_RECONNECT,
    maxAuthFailureAttempts: MAX_AUTH_FAIL,
    scene: SCENE,
    plug_version: PLUG_VERSION,
    // `ws` forwards this straight into `new WebSocket(url, opts)`. Without an
    // explicit agent, an internal-network host can never open the socket.
    ...(proxy ? { wsOptions: { agent: createHttpsProxyAgent(proxy) } } : {}),
  });

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  client.on("connected", () => log.info("WS connected"));
  client.on("authenticated", () => {
    log.info("WS authenticated");
    resolveReady();
  });
  client.on("disconnected", (reason) => log.warn({ reason }, "WS disconnected"));
  client.on("reconnecting", (attempt) => log.info({ attempt }, "WS reconnecting"));
  client.on("error", (err) => {
    log.error({ err: err.message, kind: err.constructor.name }, "WS error");
    if (err instanceof WSAuthFailureError || err instanceof WSReconnectExhaustedError) {
      rejectReady(err);
    }
  });
  client.on("event.disconnected_event", () => {
    log.error("WS kicked by server (new connection elsewhere); auto-restart suppressed");
    client.disconnect();
  });

  const shutdown = async (): Promise<void> => {
    log.info("WS shutdown");
    try {
      client.disconnect();
    } catch (e) {
      log.warn({ err: (e as Error).message }, "disconnect threw");
    }
  };

  // SDK 构造不自动连接，需显式调用。
  client.connect();

  return { client, ready, shutdown };
};
