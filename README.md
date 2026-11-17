# cbbtc-dipswing

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/joker31313131/cbbtc-dipswing/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/joker31313131/cbbtc-dipswing/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

DipSwing is a patient dip-buy mean-reversion bot for Coinbase Wrapped BTC (cbBTC) on 1-minute bars. It waits for a deep dip below the 60-bar EMA, demands a bounce confirmation before buying, then holds for a full recovery with a hard stop, a time stop, and a circuit breaker — because a round trip costs ~35 bps, a trade has to catch a real swing, not noise. One position, full size, few trades, fully deterministic: no clock, no network, no randomness.

## How it trades

- **Arm:** close more than 0.65% below EMA(60); disarm on recovery to the mean.
- **Regime filter:** no entry while the close sits above EMA(240) — a dip that is merely giving back a spike is not oversold.
- **Confirmation:** the close rises versus the previous close and sits at least 0.15% above the lowest low of the last 10 bars.
- **Impact-aware entry:** the +1.8% target must beat the expected round-trip cost estimated from the latest pool depth (fees + slippage + price impact) plus a 0.10% buffer; thin pools mean no trade.
- **Exit:** take-profit +1.8% from the fill price, hard stop −2.0%, or time stop after 480 bars held — whichever comes first, whole position.
- **Discipline:** 30-bar cooldown after any exit, 120 bars after two consecutive stop-outs, and a hard halt on entries if equity falls 4% below its intraday peak.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout (see `vendor/makefun-bars.ts`, a byte-identical copy of the kit SDK shim). Grade it locally with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h7j0gh6r&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
