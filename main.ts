// Pump.fun Paper Sprint — two-tier early-momentum bot, written from scratch.
//
// v2: the v1 single-strategy version lost -3.5 SOL on the dev window (321
// trades, 19% win rate). Offline replay analysis of the 24h dev data showed
// why: with a 5-position cap and buys capped at 1% of a coin's real SOL
// reserves, fast exits churn through losers faster than winners pay. Two
// changes fix most of it:
//
//   * CORE (at most 2 slots): coins that pump fast — price up 12%+ within
//     their first 10 trades — get a real slice (0.30 SOL, capped by the 1%
//     reserve rule) and are left alone to run: take-profit +150%, stop-loss
//     -50%. These are the lottery tickets; most lose half, a few 2.5x.
//   * SCOUT (at most 3 slots): every other coin that crosses +12% gets a
//     tiny 0.02 SOL probe with quick exits (TP +30% / SL -10%). Scouts exist
//     to keep breadth: the competition's minimum bar needs 20 distinct coins
//     with >= 0.01 SOL round trips, and in a 6h final window a slow strategy
//     alone would trade too few coins to clear it. A scout round trip costs
//     ~0.001 SOL all-in, so breadth is cheap.
//
// Both tiers only buy coins with real SOL reserves >= 8 SOL (so the 1% size
// cap still allows a meaningful buy) and a price inside 1.12x-2.5x of launch
// on a buy trade that pushed the price up. No trailing stops, no time exits:
// on this data they cut winners short without saving losers.
//
// Guardrails (from competition.yaml): >= 20 distinct coins at >= 0.01 SOL
// each, max 5 open positions, max drawdown 50%, round-trip fees ~2.5% +
// 0.00021 SOL. Dev replay of this design: ~+0.09 SOL over 24h, 302 coins,
// 57-112 coins per 6h slice (clears the 20-coin bar with room).
//
// Determinism: no clock, no Math.random, no environment reads. All decisions
// come from the batches the harness sends (slot numbers, reserves, fills).
// Iteration order is Map insertion order, which is deterministic.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// ---- tunables (all fixed units, no randomness) ------------------------------

const CORE_SIZE = 300_000_000n; // 0.30 SOL target core buy
const CORE_MIN_BUY = 50_000_000n; // 0.05 SOL: below this a core buy is not worth it
const CORE_MAX_SLOTS = 2; // at most 2 core positions at once
const CORE_TAKE_PROFIT_BPS = 25_000; // sell core at +150% over cost
const CORE_STOP_BPS = 5_000; // sell core at -50% of cost
const CORE_FAST_TRADES = 10; // core = crossed +12% within its first 10 trades

const SCOUT_SIZE = 20_000_000n; // 0.02 SOL scout probe
const SCOUT_MIN_BUY = 10_000_000n; // 0.01 SOL: the guardrail's minimum round trip
const SCOUT_MAX_SLOTS = 3; // at most 3 scout positions at once
const SCOUT_TAKE_PROFIT_BPS = 13_000; // sell scout at +30% over cost
const SCOUT_STOP_BPS = 9_000; // sell scout at -10% of cost

const MIN_REAL_SOL = 8_000_000_000n; // 8 SOL real reserves before a coin is buyable
const MIN_TRADES = 4; // trades seen before a coin can be bought
const ENTRY_LOW_BPS = 11_200; // price must be >= 12% above launch price
const ENTRY_HIGH_BPS = 25_000; // ... and <= 150% above it (do not chase the top)
const MAX_ENTRY_AGE_SLOTS = 18_000; // only coins younger than ~2h (0.4s slots)
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

type Tier = 'core' | 'scout';

const PRICE_SCALE = 1_000_000_000_000_000_000n; // 1e18

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

const coins = new Map<string, Coin>();
const bought = new Set<string>(); // mints bought once, either tier: never re-buy
const tiers = new Map<string, Tier>(); // tier of each open position

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
    if (slot - c.createdSlot > MAX_ENTRY_AGE_SLOTS && !tiers.has(mint) && !bought.has(mint)) {
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
    const tier = tiers.get(mint) ?? 'scout';
    const takeProfit = tier === 'core' ? CORE_TAKE_PROFIT_BPS : SCOUT_TAKE_PROFIT_BPS;
    const stop = tier === 'core' ? CORE_STOP_BPS : SCOUT_STOP_BPS;
    if (valueBps <= stop || valueBps >= takeProfit) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      tiers.delete(mint);
    }
  }

  // ---- entries: only on buy trades in this batch (cheap, event-driven) -----
  const txFee = state.txFeeLamports();
  let freeCash = state.freeCashLamports();
  const countTier = (tier: Tier): number => {
    let n = 0;
    for (const m of state.positions.keys()) if (tiers.get(m) === tier) n += 1;
    for (const o of orders) {
      if (o.side === 'buy' && tiers.get(o.mint) === tier) n += 1;
    }
    return n;
  };
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
    // Fast pumpers are core; everything else that crossed is a scout probe.
    const tier: Tier = c.trades <= CORE_FAST_TRADES ? 'core' : 'scout';
    if (tier === 'core' && countTier('core') >= CORE_MAX_SLOTS) continue;
    if (tier === 'scout' && countTier('scout') >= SCOUT_MAX_SLOTS) continue;
    // Size: target size capped by the 1%-of-real-reserve rule and by cash.
    const cap = state.maxBuyLamports(e.mint);
    const target = tier === 'core' ? CORE_SIZE : SCOUT_SIZE;
    const minBuy = tier === 'core' ? CORE_MIN_BUY : SCOUT_MIN_BUY;
    let size = target < cap ? target : cap;
    const affordable = freeCash - txFee;
    if (size > affordable) size = affordable;
    if (size < minBuy) continue;
    orders.push({ side: 'buy', mint: e.mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
    bought.add(e.mint);
    tiers.set(e.mint, tier);
    freeCash -= size + txFee;
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
