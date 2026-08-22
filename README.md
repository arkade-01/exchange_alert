# CEX Futures OI Scanner → Telegram

Scans perpetual-futures markets on Binance and Bybit for coins with rising open
interest *and* volume, ranks them, and posts the shortlist to a Telegram
channel. MEXC and Bitget are stubbed behind the same interface (they expose only
current OI, so they need snapshot-and-diff history before they produce deltas).

It is a **screener that surfaces candidates**, not a predictor.

## Two modes

| | `breakout` | `premove` |
|---|---|---|
| Shape | OI **and** price rising | OI rising, price **flat** |
| Window | 60m | 15m |
| Price term | rewards movement | rewards *stillness* |
| Sides | longs only | longs **and** shorts |
| Thesis | ride a move in progress | capital commits before price expands |

The two are genuinely opposed — `breakout` ranks a name higher the more it has
already moved, `premove` ranks it lower. That is why they are separate modes
with separate weights rather than one scorer with extra factors.

`MODE=both` runs them together. It costs **no additional API calls**: one OI
history fetch per symbol is taken at the deepest window any active mode needs,
and every mode derives its own window from that same series.

Pre-move stays silent until price snapshots exist — it refuses to claim a tape
is quiet without a reference to prove it. On a cold database that means no
pre-move signals for the first couple of scans, which is correct, not broken.

## Local

```bash
npm install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
npm run scan:dry          # one scan, prints the message, sends nothing
npm run scan:premove      # one pre-move scan, dry
npm run scan              # one scan, posts if there are signals
npm run loop              # continuous, every SCAN_INTERVAL_MIN
npm run report            # how past alerts actually performed
npm test                  # runs against .test.db, never the real database
```

`npm run loop -- --interval 15` overrides the interval without editing `.env`.

**Set `SCAN_INTERVAL_MIN` to at most half your shortest window.** A 15m pre-move
window polled every 10 minutes measures a ~20m period and reports it as 15m. The
worker prints a warning at boot when the cadence is too coarse.

## Measuring whether it works

Every alert is written to `alert_outcomes` with its entry price, then marked to
market on later scans at +15m, +1h and +4h. This costs nothing — the universe
call already carries the current price of everything ever alerted on.

```bash
npm run report            # last 30 days
npm run report -- 7       # last 7
```

```
# shape of the output — these numbers are illustrative, not measured results
mode      dir    n  settled   avgMFE   avgMAE    +1h     +4h   ≥1%  ≥2%  ≥5%
premove   long  41       38   +2.14%   -1.03%  +0.62%  +0.94%   61%  38%   9%
```

MFE/MAE are signed for the alert's direction, so shorts and longs share one
scale. Tune the weights against this table, not against how the alerts feel.

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
