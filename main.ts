import { runBars } from './vendor/makefun-bars.ts';

// Simple long-only cbBTC bot: hold a half position, sell overshoots, re-buy dips.
// Deterministic: no clock, no randomness, no network, no files. Integer (bigint) money math.

const SYMBOL = 'CBBTC';
const ALLOC_BPS = 5_000;        // use up to 50% of equity per entry
const LOOKBACK = 60;            // bars (1 hour)
const SELL_OVERSHOOT_BPS = 90;  // sell if close is 0.90% above close LOOKBACK bars ago
const BUY_DIP_BPS = 50;         // buy if close is 0.50% below the LOOKBACK-bar average
const TRAIL_STOP_BPS = 300;     // exit if 3% below the peak since entry
const COOLDOWN_BARS = 120;      // wait after a stop-out
const MAX_SLIPPAGE_BPS = 100;

const closes: bigint[] = [];
let peak = 0n;
let cooldownUntil = -1;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    const close = BigInt(bar.c);
    closes.push(close);
    const i = closes.length - 1;
    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      if (close > peak) peak = close;
      const stop = close * 10_000n <= peak * BigInt(10_000 - TRAIL_STOP_BPS);
      const overshoot =
        i >= LOOKBACK &&
        close * 10_000n >= closes[i - LOOKBACK] * BigInt(10_000 + SELL_OVERSHOOT_BPS);
      if (stop || overshoot) {
        if (stop) cooldownUntil = i + COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: enter on the first bar, afterwards only on a dip below the recent average.
    if (i < cooldownUntil) return [];
    if (i > 0) {
      if (i < LOOKBACK) return [];
      let sum = 0n;
      for (let k = i - LOOKBACK + 1; k <= i; k++) sum += closes[k];
      const avg = sum / BigInt(LOOKBACK);
      if (close * 10_000n > avg * BigInt(10_000 - BUY_DIP_BPS)) return [];
    }

    const { caps, fees } = state.hello;
    const weight = Math.min(ALLOC_BPS, caps.max_weight_bps);
    const target = (state.equity * BigInt(weight)) / 10_000n;
    const amount = state.cash < target ? state.cash : target;
    if (amount < BigInt(fees.min_notional_quote_units)) return [];

    peak = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: amount, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
