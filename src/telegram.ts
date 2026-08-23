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
