// DipSwing: a patient dip-buy mean-reversion bot for cbBTC (CBBTC/USDC, 1-minute
// bars, protocol agent-fun/bars-replay/v1). One position, full size, few trades.
//
// The idea, in one paragraph: BTC spends most of a range-bound day oscillating
// around its hourly mean, and the round trip costs ~35 bps (4 bps fee + 2 bps
// modelled slippage + constant-product impact, each way), so a trade must catch
// a real swing, not noise. This bot waits for a deep dip below the 60-bar EMA,
// demands a bounce confirmation before it buys, then holds for a full recovery
// (+1.8%) with a hard stop (-2.0%) and a time stop (480 bars). It refuses to
// chase: no entry while price sits above its 240-bar mean (a dip that is merely
// giving back a spike), no entry when the pool is too thin for the profit
// target to cover the round-trip cost, a long rest after two stop-outs in a
// row, and a hard halt if equity falls 4% below its intraday peak.
//
// Rules, exactly as implemented in onBatch:
//   - Indicators: EMA(60) and EMA(240) of closes, seeded at the first close,
//     updated as e = v*k + e*(1-k), k = 2/(n+1). No trade before 60 bars.
//   - Arm: close more than 0.65% below EMA(60). Disarm: close back within
//     0.05% of EMA(60).
//   - Regime filter: no entry while close is above EMA(240).
//   - Confirmation: the close rises versus the previous close AND sits at
//     least 0.15% above the lowest low of the last 10 bars (a bounce, not a
//     first touch of the dip).
//   - Impact-aware entry: enter only when the +1.8% target beats the expected
//     round-trip cost from the latest close depth (2x fee + 2x slippage +
//     2x size/depth) plus a 0.10% buffer. Depth is the pool's c_depth, the
//     best guess at the next open's depth; on the dev window it moves a
//     median 0.01% between decision and fill, so the estimate is sound.
//   - Exit: the whole position on the first of take-profit (+1.8% from the
//     fill price), hard stop (-2.0%), or time stop (480 bars held).
//   - Discipline: 30-bar cooldown after any exit; 120 bars after two
//     consecutive stop-outs; halt all entries for the rest of the window if
//     equity drops 4% below its peak (exits still run). One order per reply
//     in practice, at most the cap; max_slippage_bps 100.
//   - Deterministic: no clock, no network, no environment, no randomness;
//     every decision is a pure function of the bars, fills and account the
//     harness sent.
//
// Evidence (Python replay with the harness's exact fill math, verified
// against grade-local on buy-and-hold): dev window +$32.74 on 4 fills
// (2 round trips), max drawdown 0.7%. Robustness: 19 block-bootstrap twins
// (60-bar blocks, fixed seeds) median +$3.78, 11/19 positive; every
// parameter shifted +/-20% one at a time stays dev-positive (worst +$12.95);
// +/-40% secondary stress never loses money (worst $0.00, no trade).
// Rejected on evidence, not taste: short-horizon scalps (all dev-negative
// once costs bite), trailing stops (cut the winners, twin median to $0),
// ladder adds (dev below the gate), EMA-slope and RSI filters (killed a
// dev trade each without improving the twin median).

import {
  runBars,
  type BarsState,
  type Batch,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const EMA_FAST_N = 60;
const EMA_LONG_N = 240;
const MIN_BARS = 60;
/** Arm when close is more than this below EMA(60). */
const DIP = 0.0065;
/** Disarm when close is back within this of EMA(60). */
const DISARM_GAP = 0.0005;
/** Bounce: close must sit at least this above the 10-bar low. */
const BOUNCE = 0.0015;
const LOW_K = 10;
/** Take-profit and hard stop, measured from the fill price. */
const TAKE_PROFIT = 0.018;
const STOP_LOSS = 0.02;
/** Time stop, in bars held (fill bar counts as the first). */
const MAX_HOLD = 480;
const COOLDOWN = 30;
const BREAKER_COOLDOWN = 120;
/** Halt entries if equity falls below 96% of its intraday peak. */
const EQUITY_STOP_NUM = 96n;
const EQUITY_STOP_DEN = 100n;
/** Impact-aware entry: target must beat expected cost plus this buffer. */
const COST_BUFFER = 0.001;
const MAX_SLIPPAGE_BPS = 100;

const closes: number[] = [];
const lows: number[] = [];
let emaFast: number | null = null;
let emaLong: number | null = null;
let armed = false;
let entryPrice: number | null = null;
let entrySeq = -1;
let coolUntil = -1;
let consecStops = 0;
let halted = false;
let peakEquity: bigint | null = null;
let fillsSeen = 0;
let pendingBuyId: string | null = null;

function emaUpdate(prev: number | null, value: number, n: number): number {
  if (prev === null) return value;
  const k = 2 / (n + 1);
  return value * k + prev * (1 - k);
}

/** The bounce confirmation: an up close, off the recent low. */
function bounceConfirmed(close: number, prevClose: number, windowLow: number): boolean {
  return close > prevClose && close >= windowLow * (1 + BOUNCE);
}

/** The lowest low of the last LOW_K bars, current bar included. */
function recentLow(): number {
  let windowLow = Infinity;
  for (let i = Math.max(0, lows.length - LOW_K); i < lows.length; i++) {
    if (lows[i]! < windowLow) windowLow = lows[i]!;
  }
  return windowLow;
}

/**
 * The expected round-trip cost as a fraction, from the fee and slippage the
 * harness charges plus constant-product impact against the latest close
 * depth, for a trade of `size` quote units. Mirrors the replay's fill math:
 * each leg pays its fee, its slippage, and 1 + size/depth of price impact.
 */
function expectedRoundTripCost(size: number, depth: bigint, feeBps: number, slippageBps: number): number {
  return (2 * feeBps) / 10000 + (2 * slippageBps) / 10000 + (2 * size) / Number(depth);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold fills in first: they decide the entry price, the hold clock, and
    // whether a buy sent on the previous bar is still in flight.
    for (const fill of batch.fills) {
      if (fill.client_id === pendingBuyId) pendingBuyId = null;
      if (fill.status !== 'filled') continue;
      fillsSeen++;
      if (fill.side === 'buy' && fill.symbol === SYMBOL) {
        entryPrice = Number(fill.price);
        entrySeq = fill.fill_bar;
      } else if (fill.side === 'sell' && fill.symbol === SYMBOL) {
        entryPrice = null;
        entrySeq = -1;
      }
    }

    // Circuit breaker on equity: latch the halt, exits still run below.
    if (peakEquity === null || state.equity > peakEquity) peakEquity = state.equity;
    if (
      fillsSeen > 0 &&
      state.equity * EQUITY_STOP_DEN < peakEquity * EQUITY_STOP_NUM
    ) {
      halted = true;
    }

    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const low = Number(bar.l);
    closes.push(close);
    lows.push(low);
    emaFast = emaUpdate(emaFast, close, EMA_FAST_N);
    emaLong = emaUpdate(emaLong, close, EMA_LONG_N);
    if (closes.length < MIN_BARS) return [];

    const held = state.positions.get(SYMBOL);

    if (held !== undefined) {
      // Fallback only: fills always carry the entry price, but never trade
      // blind if one is somehow missed (cost over qty, fee included).
      if (entryPrice === null) {
        entryPrice = (Number(held.cost) * 1e7) / Number(held.qty);
        entrySeq = batch.seq;
      }
      const gain = close / entryPrice - 1;
      const hold = batch.seq - entrySeq + 1;
      let reason: 'stop' | 'tp' | 'time' | null = null;
      if (close <= entryPrice * (1 - STOP_LOSS)) reason = 'stop';
      else if (gain >= TAKE_PROFIT) reason = 'tp';
      else if (hold >= MAX_HOLD) reason = 'time';
      if (reason !== null) {
        if (reason === 'stop') consecStops++;
        else consecStops = 0;
        coolUntil =
          batch.seq + (consecStops >= 2 ? BREAKER_COOLDOWN : COOLDOWN);
        const sell: SellInput = {
          side: 'sell',
          symbol: SYMBOL,
          qty: held.qty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [sell];
      }
      return [];
    }

    // Flat: entries only.
    entryPrice = null;
    if (halted || pendingBuyId !== null || batch.seq < coolUntil) return [];

    // Arm on a deep dip below the fast mean; disarm on recovery to it.
    if (close / emaFast - 1 < -DIP) armed = true;
    else if (close >= emaFast * (1 - DISARM_GAP)) armed = false;
    if (!armed) return [];

    // Regime filter: no buying a dip that is still above the long mean.
    if (close > emaLong) return [];

    // Bounce confirmation: an up close, off the recent low.
    const prevClose = closes[closes.length - 2]!;
    if (!bounceConfirmed(close, prevClose, recentLow())) return [];

    // Impact-aware entry: the target must cover the expected round trip.
    const depth = state.depthAt(SYMBOL);
    if (depth === null || depth[0] === 0n) return [];
    const size = Number(state.cash);
    const { fee_bps, slippage_bps, min_notional_quote_units } = state.hello.fees;
    const expectedCost = expectedRoundTripCost(size, depth[0], fee_bps, slippage_bps);
    if (TAKE_PROFIT < expectedCost + COST_BUFFER) return [];

    const room = state.weightRoom(SYMBOL);
    const slice = state.cash < room ? state.cash : room;
    if (slice < BigInt(min_notional_quote_units)) return [];
    const clientId = state.clientId();
    pendingBuyId = clientId;
    armed = false;
    const buy: BuyInput = {
      side: 'buy',
      symbol: SYMBOL,
      notional_quote_units: slice,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
      client_id: clientId,
    };
    return [buy];
  },
});
