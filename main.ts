// Pump.fun Paper Sprint — early-momentum bot, written from scratch.
//
// Idea: pump.fun coins that are going to run usually show it fast. This bot
// watches every new curve, and when a coin has climbed 12%+ off its launch
// price on real buy flow while its bonding curve still has room (real SOL
// reserves >= 8 SOL), it buys a small fixed slice. Every position then rides
// with a stop-loss, a take-profit, a trailing stop once it is well up, and a
// hard time exit so no dead coin is held into the end of the window.
//
// Guardrails the strategy is built around (from competition.yaml):
//   - at least 20 distinct coins, each bought for >= 0.01 SOL
//   - max 5 open positions, max drawdown 50%
//   - round-trip fees are ~2.5% + 0.00021 SOL, so exits must clear that
//
// Determinism: no clock, no Math.random, no environment reads. All decisions
// come from the batches the harness sends (slot numbers, reserves, fills).
// Iteration order is Map insertion order, which is deterministic.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (all in fixed units, no randomness) ---------------------------

const BUY_SOL = 300_000_000n; // 0.30 SOL target buy size
const MIN_BUY_SOL = 50_000_000n; // 0.05 SOL: below this a buy is not worth the fees
const MIN_REAL_SOL = 8_000_000_000n; // 8 SOL real reserves before a coin is buyable
const MIN_TRADES = 4; // trades seen before a coin can be bought
const ENTRY_LOW_BPS = 11_200; // price must be >= 12% above launch price
const ENTRY_HIGH_BPS = 25_000; // ... and <= 150% above it (do not chase the top)
const MAX_ENTRY_AGE_SLOTS = 18_000; // only coins younger than ~2h (0.4s slots)
const STOP_BPS = 8_500; // sell when marked value <= 85% of cost
const TAKE_PROFIT_BPS = 18_000; // sell everything at +80% over cost
const TRAIL_ARM_BPS = 13_000; // trailing stop arms once value >= +30% over cost
const TRAIL_DROP_BPS = 7_500; // ... then sell if value falls to 75% of its peak
const TIME_EXIT_SLOTS = 14_400; // ~96 min: sell if at/above breakeven
const HARD_EXIT_SLOTS = 28_800; // ~3.2h: sell whatever is left
const SLIPPAGE_BPS = 500;

// ---- per-coin tracking --------------------------------------------------------

interface Coin {
  mint: string;
  createdSlot: number;
  createPrice: bigint; // quote lamports per token, scaled by 1e18 (integer math)
  trades: number;
  lastPrice: bigint;
  prevPrice: bigint;
  realSol: bigint;
  complete: boolean;
}

interface Held {
  mint: string;
  boughtSlot: number;
  peakValueBps: number; // peak marked value as bps of cost
}

const PRICE_SCALE = 1_000_000_000_000_000_000n; // 1e18

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

const coins = new Map<string, Coin>();
const bought = new Set<string>(); // mints bought once: never re-buy after exit
const held = new Map<string, Held>();

function trackCreate(mint: string, slot: number, virtualQuote: bigint, virtualToken: bigint): void {
  if (coins.has(mint)) return;
  const p = priceOf(virtualQuote, virtualToken);
  if (p === 0n) return;
  coins.set(mint, {
    mint,
    createdSlot: slot,
    createPrice: p,
    trades: 0,
    lastPrice: p,
    prevPrice: p,
    realSol: 0n,
    complete: false,
  });
}

function trackTrade(mint: string, slot: number, virtualQuote: bigint, virtualToken: bigint, realSol: bigint): void {
  let c = coins.get(mint);
  if (c === undefined) {
    // First seen through a trade (no CreateEvent delivered): treat this as launch.
    const p = priceOf(virtualQuote, virtualToken);
    if (p === 0n) return;
    c = {
      mint,
      createdSlot: slot,
      createPrice: p,
      trades: 0,
      lastPrice: p,
      prevPrice: p,
      realSol,
      complete: false,
    };
    coins.set(mint, c);
  }
  c.prevPrice = c.lastPrice;
  c.lastPrice = priceOf(virtualQuote, virtualToken);
  c.realSol = realSol;
  c.trades += 1;
}

function pruneOld(slot: number): void {
  // Drop coins that aged out of the entry window and are not held: keeps the
  // per-batch work bounded over a 24h dev window / 6h final window.
  for (const [mint, c] of coins) {
    if (slot - c.createdSlot > MAX_ENTRY_AGE_SLOTS && !held.has(mint) && !bought.has(mint)) {
      coins.delete(mint);
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = batch.slot;

  // Fold this batch's events into the per-coin table, in chain order.
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      trackCreate(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
    } else if (e.event === 'TradeEvent') {
      trackTrade(e.mint, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves), BigInt(e.real_quote_reserves));
    } else {
      const c = coins.get(e.mint);
      if (c !== undefined) c.complete = true;
    }
  }

  // ---- exits first: free slots and cash before considering new buys --------
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price === 0n || pos.cost_lamports === 0n) continue;
    const value = (pos.token_amount * price) / PRICE_SCALE; // lamports, approx
    const valueBps = Number((value * 10_000n) / pos.cost_lamports);
    const h = held.get(mint);
    if (h !== undefined && valueBps > h.peakValueBps) h.peakValueBps = valueBps;

    let sell = false;
    if (valueBps <= STOP_BPS) sell = true; // stop-loss
    else if (valueBps >= TAKE_PROFIT_BPS) sell = true; // take-profit
    else if (h !== undefined && h.peakValueBps >= TRAIL_ARM_BPS && valueBps * 10_000 <= h.peakValueBps * TRAIL_DROP_BPS) sell = true; // trailing stop
    else if (h !== undefined && slot - h.boughtSlot >= HARD_EXIT_SLOTS) sell = true; // hard time exit
    else if (h !== undefined && slot - h.boughtSlot >= TIME_EXIT_SLOTS && valueBps >= 10_000) sell = true; // timed breakeven exit

    if (sell) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      held.delete(mint);
    }
  }

  // ---- entries: only on buy trades in this batch (cheap, event-driven) -----
  const openSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
  if (openSlots > 0 && orders.length < state.hello.caps.max_orders_per_batch) {
    let freeCash = state.freeCashLamports();
    const txFee = state.txFeeLamports();
    for (const e of batch.events) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
      if (e.event !== 'TradeEvent' || !e.is_buy) continue;
      const c = coins.get(e.mint);
      if (c === undefined || c.complete) continue;
      if (bought.has(e.mint) || state.positions.has(e.mint)) continue;
      if (c.trades < MIN_TRADES) continue;
      if (slot - c.createdSlot > MAX_ENTRY_AGE_SLOTS) continue;
      if (c.realSol < MIN_REAL_SOL) continue;
      // Price must be inside the momentum band vs launch price.
      const ratioBps = Number((c.lastPrice * 10_000n) / c.createPrice);
      if (ratioBps < ENTRY_LOW_BPS || ratioBps > ENTRY_HIGH_BPS) continue;
      // Last trade must have pushed the price up, not down.
      if (c.lastPrice <= c.prevPrice) continue;
      // Size: target size capped by the 1%-of-real-reserve rule and by cash.
      const cap = state.maxBuyLamports(e.mint);
      let size = BUY_SOL < cap ? BUY_SOL : cap;
      const affordable = freeCash - txFee;
      if (size > affordable) size = affordable;
      if (size < MIN_BUY_SOL) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      bought.add(e.mint);
      held.set(e.mint, { mint: e.mint, boughtSlot: slot, peakValueBps: 10_000 });
      freeCash -= size + txFee;
    }
  }

  // Periodic prune (every batch is fine: the map stays small either way, and
  // iteration order is deterministic).
  pruneOld(slot);
  return orders;
}

function onHello(state: BotState): void {
  // Nothing to seed: all state derives from the batches. The seed is only
  // used if a tie-break ever needs it; none is needed here.
  void state.hello.seed;
}

await runBot({ onHello, onBatch });
