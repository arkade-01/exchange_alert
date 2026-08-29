import { config } from "./config.js";
import { sendMessage } from "./telegram.js";
import { formatReport, outcomeStats } from "./tracking.js";

/**
 * On-demand commands over Telegram.
 *
 * The worker has no shell on most hosts, so a chat command is the only way to
 * ask it something between scheduled reports. Long polling keeps this cheap:
 * one held-open request rather than a busy loop, so a `/report` comes back in
 * about a second instead of waiting for the next scan.
 *
 * Only TELEGRAM_REPORT_CHAT_ID is obeyed. The bot is an admin of a public
 * channel, so anyone can find it and message it — without that check, a
 * stranger could pull your performance history.
 */

const API = () => `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Update {
  update_id: number;
  message?: {
    chat: { id: number | string };
    text?: string;
  };
}

let running = false;
let offset = 0;

const HELP = [
  "<b>Commands</b>",
  "",
  "/report [days] - performance of past alerts (default 7)",
  "/help - this message",
].join("\n");

async function handle(text: string): Promise<void> {
  const [cmd, arg] = text.trim().split(/\s+/);
  const chat = config.TELEGRAM_REPORT_CHAT_ID;

  switch ((cmd ?? "").split("@")[0]) {
    case "/report": {
      const days = Number(arg) > 0 ? Number(arg) : 7;
      const text = formatReport(outcomeStats(days), days);
      await sendMessage(`<pre>${text}</pre>`, chat);
      break;
    }
    case "/start":
    case "/help":
      await sendMessage(HELP, chat);
      break;
    default:
      // Silence for anything unrecognised — this is a private control channel,
      // not a chatbot, and echoing back invites noise.
      break;
  }
}

async function poll(): Promise<void> {
  while (running) {
    try {
      const res = await fetch(
        `${API()}/getUpdates?offset=${offset}&timeout=30` +
          `&allowed_updates=${encodeURIComponent('["message"]')}`,
        { signal: AbortSignal.timeout(40_000) },
      );

      if (res.status === 409) {
        // A webhook or a second instance owns the update stream. Polling on
        // would fight it forever, so step aside rather than loop on errors.
        console.error(
          "telegram commands: another listener owns getUpdates — disabling",
        );
        running = false;
        return;
      }
      if (!res.ok) {
        await sleep(5_000);
        continue;
      }

      const body = (await res.json()) as { ok: boolean; result?: Update[] };
      for (const u of body.result ?? []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text) continue;
        // Channel posts and strangers both land here; neither is authorised.
        if (String(msg.chat.id) !== config.TELEGRAM_REPORT_CHAT_ID) continue;
        try {
          await handle(msg.text);
        } catch (err) {
          console.error(`command failed: ${(err as Error).message}`);
        }
      }
    } catch {
      // Timeouts are the normal end of a long poll, not a fault.
      await sleep(1_000);
    }
  }
}

/** No-op unless a report chat is configured — there is no one to answer. */
export function startCommandListener(): void {
  if (running) return;
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_REPORT_CHAT_ID) return;
  running = true;
  void poll();
  console.error("telegram commands: listening for /report");
}

export function stopCommandListener(): void {
  running = false;
}
