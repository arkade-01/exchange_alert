# CEX Futures OI Scanner → Telegram

Scans perpetual-futures markets on Binance and Bybit for coins with rising open
interest *and* volume, ranks them, and posts the shortlist to a Telegram
channel. MEXC and Bitget are stubbed behind the same interface (they expose only
current OI, so they need snapshot-and-diff history before they produce deltas).

It is a **screener that surfaces candidates**, not a predictor.

## Local

```bash
npm install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
npm run scan:dry          # one scan, prints the message, sends nothing
npm run scan              # one scan, posts if there are signals
npm run loop              # continuous, every SCAN_INTERVAL_MIN
npm test                  # runs against .test.db, never the real database
```

`npm run loop -- --interval 15` overrides the interval without editing `.env`.

## Deploy (Railway)

1. Create a service from this repo. `railway.json` supplies the build and start
   commands; `npm start` runs the compiled `dist/` build in loop mode.
2. **Attach a Volume, mount path `/data`.** Not optional — see below.
3. Set variables:
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   - `DB_PATH=/data/oi-scanner.db`
   - any threshold you tuned away from the defaults in `.env.example`
4. Leave `DNS_SERVERS` **unset**. It exists only for networks whose resolver
   blocks the exchange APIs; Railway reaches them fine.

### Why the volume matters

SQLite holds the alert cooldowns and the MEXC/Bitget snapshot history. Railway's
container filesystem is destroyed on every redeploy, so without a volume each
deploy would start from an empty database — re-announcing every coin currently
in the bucket, and never accruing enough history for the snapshot-based
exchanges to work at all.

As a backstop, a worker that boots with **no alert history at all** treats its
first scan as a baseline: cooldowns are recorded, nothing is sent. So a lost
volume costs you one scan of signals rather than a channel full of duplicates.

## Telegram setup

The bot must be an **admin of the channel with "Post Messages"**. For a public
channel, `TELEGRAM_CHAT_ID=@channelname` is enough. For a private one, post a
message in the channel and read `channel_post.chat.id` from
`https://api.telegram.org/bot<TOKEN>/getUpdates` — it looks like `-100…`.

## Gotchas

- Open interest exists only on perps/futures, never spot.
- MEXC and Bitget return `null` deltas until snapshot history accrues. Expected.
- `.env` is gitignored and must stay that way — it holds the bot token.
