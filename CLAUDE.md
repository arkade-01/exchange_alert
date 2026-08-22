# CLAUDE.md — CEX Futures OI Scanner → Telegram

Build a worker that scans perpetual-futures markets across **Binance, Bybit, MEXC, and Bitget** for coins with **rising open interest + volume** as potential daily-gainer candidates, and posts ranked alerts to a **Telegram channel**.

Stack: **TypeScript / Node 18+**. Telegram is the alert output.

---

## Build order

1. **Binance + Bybit first.** Both expose native OI-history endpoints, so signals work the moment you run it — no data accumulation needed.
2. **MEXC + Bitget behind the same interface, stubbed.** They only return *current* OI, so they need snapshot-and-diff: persist OI on each poll and compute the delta once history exists. Leave clear extension points; do **not** block v1 on them.

---

## Endpoints

### Binance (USDT perps)
- Universe / volume / 24h price: `GET https://fapi.binance.com/fapi/v1/ticker/24hr`
  - fields: `symbol`, `quoteVolume` (USDT 24h vol), `priceChangePercent`, `lastPrice`
  - filter to symbols ending in `USDT`, exclude any with `_` (quarterlies)
- OI history: `GET https://fapi.binance.com/futures/data/openInterestHist?symbol=<S>&period=<p>&limit=<n>`
  - `period` ∈ 5m,15m,30m,1h,2h,4h,6h,12h,1d ; max `limit` 500 ; ~30 days retained
  - use `sumOpenInterestValue` (USD notional); oldest vs newest across the window = OI delta
  - for a 1h window at period=5m → limit=13
- Funding: `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=<S>` → `lastFundingRate`

### Bybit v5 (linear perps)
- Universe (one call, rich): `GET https://api.bybit.com/v5/market/tickers?category=linear`
  - fields: `symbol`, `turnover24h` (USD vol), `price24hPcnt` (decimal, 0.05 = 5%), `lastPrice`, `openInterest`, `fundingRate`
- OI history: `GET https://api.bybit.com/v5/market/open-interest?category=linear&symbol=<S>&intervalTime=<i>&limit=<n>`
  - `intervalTime` ∈ 5min,15min,30min,1h,4h,1d ; max `limit` 200
  - `result.list` → `[{ openInterest, timestamp }]`; **sort by timestamp** (don't assume order)

### MEXC / Bitget — stubbed, snapshot-and-diff
- MEXC futures: `https://contract.mexc.com` — ticker exposes `holdVol` (current OI)
- Bitget: `GET https://api.bitget.com/api/v2/mix/market/open-interest` (current OI only)
- On each poll, write current OI to `snapshots`; compute delta from the nearest snapshot ≥ window ago. Returns null delta until enough history exists — that's expected.

All market-data endpoints are public (no API key). Symbol naming: both Binance and Bybit linear use `BTCUSDT`.

---

## Architecture

```
src/
  config.ts          # env + thresholds, zod-validated
  modes.ts           # breakout + premove: gates, weights, classification
  tracking.ts        # alert outcomes: mark-to-market + report
  db.ts              # better-sqlite3: snapshots + cooldowns + outcomes
  exchanges/
    base.ts          # Exchange interface
    binance.ts
    bybit.ts
    mexc.ts          # stub (snapshot-and-diff)
    bitget.ts        # stub (snapshot-and-diff)
  scanner.ts         # orchestration + scoring + classification + dedup
  telegram.ts        # sendMessage, HTML, 4096 chunking
  index.ts           # CLI: --once | --loop --interval, --dry-run
```

### Exchange interface
```ts
export interface Candidate {
  exchange: string;
  symbol: string;        // BTCUSDT
  base: string;          // BTC
  quoteVol24hUsd: number;
  priceChgPct24h: number;
  lastPrice: number;
  fundingRate: number;
}
export interface OiPoint { ts: number; oi: number; }
export interface OiChange { oiNow: number; oiPrev: number; deltaPct: number | null; }

export interface Exchange {
  name: string;
  getUniverse(): Promise<Candidate[]>;
  // Returns the SERIES, not a single delta — one fetch answers every mode's
  // window. Derive deltas with deltaOverWindow().
  getOiHistory(symbol: string, lookbackMinutes: number): Promise<OiPoint[]>;
}
```

### Flow (per scan)
1. `getUniverse()` for each enabled exchange (one call each).
2. Gate by `quoteVol24hUsd >= MIN_VOLUME` **before** fetching OI (cuts noise + API calls).
3. Fetch `getOiHistory` for survivors in parallel, bounded by `p-limit` (concurrency ~8).
   One call per symbol at the deepest window any active mode needs — never one per mode.
4. Normalize to **base asset** (strip `USDT`) and merge across exchanges — same base firing on >1 exchange is a stronger signal.
5. Score, classify, apply cooldown, rank, format, send.

Libraries: native `fetch`; `p-limit` (bounded parallelism); `better-sqlite3` (sync, zero-config persistence); `node-cron` or `setInterval` (loop); `dotenv` + `zod` (config). Add `grammy` only if the bot later needs to take commands (`/scan`, `/mute ARB`).

---

## Scoring

Hard filters gate candidacy; a normalized composite ranks what passes.

```ts
// Gates (must pass):
quoteVol24hUsd >= MIN_VOLUME        // e.g. 10_000_000
oiDeltaPct     >= MIN_OI_DELTA      // e.g. 5   (% over the window)
priceChgPct24h <= MAX_PCHG_24H      // e.g. 40  (skip already-run names)

// Classify by OI vs price direction (window price if you fetch klines, else 24h):
//   OI↑ & px↑ → "longs building"    ← gainer bucket, the ones you alert
//   OI↑ & px↓ → "shorts building"
//   OI↓ & px↑ → "short covering"
//   OI↓ & px↓ → "longs closing"

// Composite (rank the longs-building bucket):
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const nOi     = clamp01(oiDeltaPct / 25);                       // 25% OI rise = max
const nVol    = clamp01(Math.log10(quoteVol24hUsd / 1e7) / 2);  // 10M→0, 1B→1
const nPrice  = clamp01(priceChgPctWindow / 10);               // 10% window move = max
const funding = clamp01(Math.abs(fundingRate) / 0.001);       // crowding penalty
const cross   = Math.min(exchangesFiring - 1, 2) * 0.15;      // multi-exchange bonus, up to +0.30

score = 0.45*nOi + 0.20*nVol + 0.25*nPrice + cross - 0.15*funding;
// Computed 0..1-ish (real range ~-0.15..1.20); displayed x100 as an integer.
```

### Pre-move mode (`MODE=premove`)

The inverted thesis: capital committing *before* price expands. Same pipeline,
opposite price term.

```ts
// Gates (must pass):
quoteVol24hUsd  >= MIN_VOLUME
oiDeltaPct      >= PREMOVE_MIN_OI_DELTA           // e.g. 3, over a 15m window
priceChgPctWindow !== null                        // "quiet" must be shown, not assumed
|priceChgPctWindow| <= PREMOVE_MAX_ABS_PCHG_WINDOW // e.g. 1.5 - quiet RIGHT NOW
|priceChgPct24h|    <= PREMOVE_MAX_ABS_PCHG_24H    // e.g. 12  - hasn't ALREADY GONE
score           >= PREMOVE_MIN_SCORE              // looser gates need a floor

// Buckets: BOTH building regimes qualify - this mode calls shorts too.
//   OI up & px up   -> "longs building"  -> long bias
//   OI up & px down -> "shorts building" -> short bias

// The term that flips: flat tape scores 1, moving tape scores 0.
const quiet = 1 - clamp01(Math.abs(priceChgPctWindow) / PREMOVE_MAX_ABS_PCHG_WINDOW);

score = 0.40*nOi + 0.15*nVol + 0.30*quiet + cross - 0.15*funding;
```

**Pre-move needs its own 24h ceiling**, far tighter than breakout's 40%. Quiet
over a 15m window and "hasn't moved yet" are not the same claim: a coin up 35%
on the day that goes flat for a quarter of an hour is late longs into a topped
move. Two price gates on different timescales is the only pre/post discriminator
available from OI and price alone — separating them properly needs order flow
(taker imbalance, funding divergence, multi-timeframe momentum).

**Do not merge the two weight sets.** `breakout` rewards price movement and
`premove` penalises it; a single scorer cannot express both. `MODE=both` runs
them side by side off one shared OI fetch.

Cooldown keys are `"<mode>:<direction>:<base>"` — a long and a short on the same
coin are different claims and must not mute each other.

---

## Post-signal tracking

Every alert lands in `alert_outcomes` with its entry price and is marked to
market on later scans at +15m/+1h/+4h. **Zero API cost**: the universe call
already carries the current price of every base ever alerted on.

MFE/MAE are signed for the alert's direction, so a short that falls 3% records
+3 and long/short performance aggregate on one scale. `--report [days]` prints
hit rates per mode and side.

This exists so the thresholds are falsifiable. Tune weights against the report,
not against whether the alerts look plausible.

- OI delta carries the most weight — it's the fresh signal.
- Volume is log-scaled so a $1B coin doesn't drown a $30M mover.
- If you skip the extra klines call, drop `nPrice` and scale 24h price by `/40` instead.
- Every constant is a tunable — surface them all in `config.ts`.

---

## Dedup / cooldown (decide up front)

Without it, the same coin re-alerts every scan. Use SQLite (already present for snapshots): store `last_alerted_ts` per `(exchange|base)`. Don't re-alert unless the symbol left the bucket and came back, **or** `ALERT_COOLDOWN_MIN` (e.g. 60) has elapsed.

---

## Telegram

- Bot via BotFather → added as **admin** to the channel.
- `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
- payload: `{ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }`
- `chat_id` = `@channelname` or numeric `-100…`
- HTML parse mode; **chunk at 4096 chars**.
- `--dry-run` prints the exact same string to console instead of sending.

### Message format
```
🟢 <b>OI Scanner</b> — 3 signals · 1h window
<i>14:32 UTC</i>

<b>1. ARB</b>  score 82
  OI <b>+12.4%</b> · px +3.1% · vol $84M
  longs building · Binance, Bybit · funding 0.011%

<b>2. SUI</b>  score 74
  OI <b>+9.8%</b> · px +1.2% · vol $210M
  longs building · Bybit · funding 0.004%
```

---

## Config (env)

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=          # @name or -100...
MODE=breakout              # breakout | premove | both
EXCHANGES=binance,bybit    # mexc,bitget once history accrues
WINDOW_MINUTES=60
MIN_VOLUME=10000000
MIN_OI_DELTA=5
MAX_PCHG_24H=40
ALERT_COOLDOWN_MIN=60
SCAN_INTERVAL_MIN=10        # must be <= half the shortest active window
CONCURRENCY=8

# Pre-move only
PREMOVE_WINDOW_MINUTES=15
PREMOVE_MIN_OI_DELTA=3
PREMOVE_MAX_ABS_PCHG_WINDOW=1.5
PREMOVE_MAX_ABS_PCHG_24H=12
PREMOVE_MIN_SCORE=0.35
PM_W_OI=0.40
PM_W_VOL=0.15
PM_W_QUIET=0.30

PRICE_REF_STALENESS_MIN=0   # 0 = auto (1.5 scan intervals, min 5m)
TRACK_OUTCOMES=true
```

---

## CLI
- `--once` — single scan, exit.
- `--loop --interval <min>` — continuous (default 5–15 min).
- `--dry-run` — console instead of Telegram.
- `--report [days]` — how past alerts actually performed (default 30d).

---

## Notes / gotchas
- OI exists only on perps/futures, never spot.
- MEXC + Bitget get smarter the longer the worker runs (they start with null deltas).
- Rate limits on market-data endpoints are generous, but batch universe calls (one per exchange) and bound the per-symbol OI fan-out with `p-limit`.
- This is a **screener that surfaces candidates**, not a predictor — keep thresholds tunable and don't oversell any single signal.
- A scan cadence coarser than half the shortest window silently stretches it: a 15m window polled every 10 min measures ~20m. The worker warns at boot.
- Pre-move yields nothing on a cold database until price snapshots accrue. That is correct behaviour — it will not claim a tape is quiet without a reference.