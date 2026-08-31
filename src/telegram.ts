import { assertTelegramConfigured, config } from "./config.js";

const TELEGRAM_LIMIT = 4096;

/**
 * Split on paragraph, then line, then hard-cut — never mid-tag, so each chunk
 * stays valid HTML for Telegram's parser.
 */
export function chunk(text: string, limit = TELEGRAM_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const head = rest.slice(0, limit);
    let cut = head.lastIndexOf("\n\n");
    if (cut < limit * 0.5) cut = head.lastIndexOf("\n");
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Escape text destined for HTML parse mode. Required for anything we did not
 * author as markup — a report row reading "fresh (<15m)" is otherwise parsed
 * as an unknown start tag and the whole send is rejected with a 400.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;") // must run first, or it double-escapes the rest
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send plain text inside a <pre> block.
 *
 * Escaping happens before chunking, and each chunk is wrapped individually:
 * wrapping first would let a long report split between the opening and closing
 * tag, leaving both halves invalid.
 */
export async function sendPreformatted(
  text: string,
  chatId = config.TELEGRAM_CHAT_ID,
): Promise<void> {
  for (const part of chunk(escapeHtml(text), TELEGRAM_LIMIT - 32)) {
    await sendMessage(`<pre>${part}</pre>`, chatId);
  }
}

/**
 * Upload a file to a chat. The 4096-character message limit makes per-signal
 * detail impossible inline — thousands of rows only travel as an attachment.
 */
export async function sendDocument(
  filename: string,
  content: string,
  chatId = config.TELEGRAM_CHAT_ID,
  caption?: string,
): Promise<void> {
  assertTelegramConfigured();
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "HTML");
  }
  form.append(
    "document",
    new Blob([content], { type: "text/csv" }),
    filename,
  );

  const res = await fetch(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form, signal: AbortSignal.timeout(60_000) },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendDocument ${res.status}: ${body.slice(0, 300)}`);
  }
}

export async function sendMessage(
  text: string,
  chatId = config.TELEGRAM_CHAT_ID,
): Promise<void> {
  assertTelegramConfigured();
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;

  for (const part of chunk(text)) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: part,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(config.HTTP_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram sendMessage ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}
