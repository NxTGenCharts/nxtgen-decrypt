// =============================================================
// grid.js — NxTGen Grid: the 7th independent strategy.
//
// This is intentionally a SEPARATE engine from setups.js/engine.js's
// ensemble of single-entry, TP1/TP2/TP3 detectors. A grid deployment is
// not "one signal -> one position" — it's many simultaneous limit
// levels on ONE symbol, managed as a unit, opened and closed as a
// group. Bolting that onto STRATEGY_REGISTRY's detectAllSetups (which
// assumes exactly one entry/stop/TP ladder per fired signal) would mean
// either breaking that shared assumption for all six existing
// strategies or silently mis-modeling the grid. So NxTGen Grid is
// registered here, independently (GRID_STRATEGY below), wired into the
// UI/backtest as its own strategy alongside the STRATEGY_REGISTRY six
// — never inside it, and never touching evaluateSymbol/detectAllSetups.
//
// Everything here is pure/deterministic given the candles + config
// passed in, same discipline as regime.js/setups.js: no DOM, no
// network, no global state, so the exact same functions run in
// Backtest, Paper, and (once wired into server.js's order placement —
// see the header note on runGridBacktest below) Live/Demo.
// =============================================================
import { atr, adx, bollingerBands, vwap, swingLevels, volumeExpansion, closes } from './indicators.js';
import { classifyRegime, REGIMES } from './regime.js';
import { DEFAULT_FEE_CONFIG } from './costs.js';
import { estimateLiquidationPrice } from './risk.js';
import { TRADEABLE_FUTURES_SYMBOLS } from './engine.js';

// -------------------------------------------------------------
// Registry entry — deliberately NOT part of STRATEGY_REGISTRY (see
// header). The UI (futures-ui.js / backtest-ui.js) renders this
// alongside that list's six so the user sees all 7 in one place, but
// keeps them in separate config objects since the two engines take
// different config shapes.
// -------------------------------------------------------------
export const GRID_STRATEGY = {
  id: 'nxtgenGrid',
  type: 'NxTGen Grid',
  label: 'NxTGen Grid',
  defaultEnabled: false, // new + structurally different from the other six — opt in explicitly
  description: 'Adaptive futures grid: trades a dynamically-sized range of limit levels only in confirmed range-bound conditions, sized and fee-gated per level, with breakout/liquidation/daily-loss protection. Not a fixed-percent grid, and not always in the market — see the Grid Score gate.',
};

// Previously a hardcoded set of liquid majors (BTC/ETH/SOL/BNB/XRP/
// DOGE) on the theory that a grid specifically wants the deepest order
// books, unlike the other six strategies which exclude those majors as
// too "clean"/low-edge for momentum scalps (engine.js's
// EXCLUDED_FUTURES_SYMBOLS). In practice that meant most of Grid's pair
// choices (5 of 6) were exactly the pairs the rest of the app
// deliberately avoids trading. Grid now shares the same watchlist as
// the regular six-strategy engine — TRADEABLE_FUTURES_SYMBOLS, i.e.
// FUTURES_SYMBOLS minus EXCLUDED_FUTURES_SYMBOLS — so those majors stay
// excluded everywhere, not just in the other six.
export const GRID_SYMBOLS = TRADEABLE_FUTURES_SYMBOLS;

export const GRID_DEFAULTS = {
  mode: 'AUTO',              // AUTO | LONG | SHORT | NEUTRAL
  minGridScore: 75,          // 0-100, below this: do not deploy
  minConfidence: 75,
  maxLeverage: 5,            // hard safety ceiling regardless of user input
  minGridLevels: 5,
  maxGridLevels: 50,
  defaultGridLevels: 12,
  minNetProfitPct: 0.20,     // per-level round-trip, AFTER fees/spread/slippage/funding
  maxGridAllocationPct: 20,  // % of equity one grid deployment may use
  maxAccountExposurePct: 60, // % of equity across ALL open grid legs, all symbols
  maxDailyLossPct: 2.0,
  dailyProfitTargetPct: 10.0,
  maxGridLossPct: 8.0,       // emergency-close THIS grid if its own drawdown exceeds this % of its allocation
  maxAccountDrawdownPct: 15.0,
  liquidationBufferRatio: 1.75, // liquidation must be this many multiples farther than the grid's own worst-case adverse excursion
  breakoutSensitivityAtr: 1.2,  // candle close beyond boundary by this many ATRs, confirmed
  breakoutVolumeMult: 1.4,      // + volume expansion at least this much, to filter false breakouts
  recalcDriftPct: 35,           // % of grid half-width the price must drift beyond boundary (without a confirmed breakout) before recalculating
  fundingFilterOn: true,
  liquidityFilterOn: true,
  minVolume24hUsd: 15_000_000,
  emergencyExitOn: true,
};

// -------------------------------------------------------------
// Suitability scoring — the "Entry Confidence" system from the spec,
// 100 points across 8 components. Below GRID_DEFAULTS.minGridScore, the
// strategy makes ZERO trades: that null return is the point, not a bug
// to work around.
// -------------------------------------------------------------
export function scoreGridSuitability(snap, regime, cfg){
  const c = { ...GRID_DEFAULTS, ...cfg };
  const m15 = snap.m15, h1 = snap.h1, m5 = snap.m5;
  if(!m15 || m15.length < 30 || !h1 || h1.length < 30 || !m5 || m5.length < 30){
    return { score: 0, breakdown: {}, reasons: ['Insufficient multi-timeframe history'], regimeOk: false };
  }

  const bb = bollingerBands(m15, 20, 2);
  const adx1h = adx(h1, 14);
  const atrM15 = atr(m15, 14);
  const vwapM15 = vwap(m15.slice(-60));
  const { support, resistance } = swingLevels(m15, 96);
  const last = m5[m5.length - 1];
  const rangeWidthPct = support ? ((resistance - support) / support) * 100 : 0;
  const volExp = volumeExpansion(m5, 20);

  const reasons = [];
  const breakdown = {};

  // Regime eligibility gate: RANGE is the primary target; WEAK trends
  // are allowed with a directional bias (per spec); STRONG trends,
  // HIGH_VOL, and CHAOTIC are hard no-trade regimes for a grid.
  const eligible = regime.regime === REGIMES.RANGE || regime.regime === REGIMES.LOW_VOL
    || regime.regime === REGIMES.WEAK_BULL || regime.regime === REGIMES.WEAK_BEAR;
  if(!eligible){
    reasons.push(`Regime "${regime.regime}" is not grid-suitable (need Range/Low-Vol, or a weak trend for directional bias)`);
    return { score: 0, breakdown, reasons, regimeOk: false, regime, rangeWidthPct };
  }

  // 1. Range quality (20) — tighter, more clearly bounded ranges score higher.
  let rangeQuality = 0;
  if(rangeWidthPct > 0){
    if(rangeWidthPct >= 2 && rangeWidthPct <= 10) rangeQuality = 20;
    else if(rangeWidthPct > 10 && rangeWidthPct <= 16) rangeQuality = 12;
    else if(rangeWidthPct < 2) rangeQuality = 6; // too tight — fees will eat it, handled again below
    else rangeQuality = 4; // too wide to call a clean range
  }
  breakdown.rangeQuality = rangeQuality;
  reasons.push(`Range width ${rangeWidthPct.toFixed(2)}% (support ${support.toFixed(4)} / resistance ${resistance.toFixed(4)})`);

  // 2. Low trend strength (15) — ADX below ~20 is conventionally non-trending.
  let trendScore = 0;
  if(adx1h != null){
    if(adx1h < 18) trendScore = 15;
    else if(adx1h < 25) trendScore = 9;
    else if(adx1h < 32) trendScore = 3;
    else trendScore = 0;
  } else trendScore = 6; // unknown — neutral, don't over-penalize
  breakdown.trendStrength = trendScore;
  if(adx1h != null) reasons.push(`ADX(1h) ${adx1h.toFixed(1)}`);

  // 3. Volatility suitability (15) — BB width should be present but not
  // extreme; extremes in either direction hurt (too tight = fees eat
  // spacing, too wide = regime is really trending/breaking out).
  let volScore = 0;
  const bbWidthPct = bb ? bb.widthPct : null;
  if(bbWidthPct != null){
    if(bbWidthPct >= 1.5 && bbWidthPct <= 8) volScore = 15;
    else if(bbWidthPct > 8 && bbWidthPct <= 13) volScore = 8;
    else if(bbWidthPct < 1.5) volScore = 4;
    else volScore = 0;
  }
  breakdown.volatility = volScore;
  if(bbWidthPct != null) reasons.push(`BB width ${bbWidthPct.toFixed(2)}%`);

  // 4. Support/resistance quality (15) — how many confirmed swing
  // touches define the boundaries (more structure = more trustworthy level).
  const { swingHighs, swingLows } = swingLevels(m15, 96);
  const touchCount = Math.min(swingHighs.length, swingLows.length);
  const srQuality = touchCount >= 3 ? 15 : touchCount === 2 ? 10 : touchCount === 1 ? 5 : 0;
  breakdown.supportResistance = srQuality;
  reasons.push(`${touchCount} confirmed swing high/low pair(s) framing the range`);

  // 5. Volume quality (10) — steady, not spiking (spiking volume in a
  // "range" is often the leading edge of a breakout, not confirmation of one).
  const volScore2 = volExp >= 0.6 && volExp <= 1.3 ? 10 : volExp < 0.6 ? 5 : volExp <= 1.8 ? 4 : 0;
  breakdown.volumeQuality = volScore2;
  reasons.push(`Volume ${volExp.toFixed(2)}x recent average`);

  // 6. Higher-timeframe alignment (10) — 4h/1h shouldn't be showing an
  // opposing strong trend even if 15m/5m look range-bound right now.
  const htfClose = closes(h1);
  const htfDriftPct = htfClose.length >= 24 ? ((htfClose[htfClose.length - 1] - htfClose[htfClose.length - 24]) / htfClose[htfClose.length - 24]) * 100 : 0;
  const htfAlign = Math.abs(htfDriftPct) < 3 ? 10 : Math.abs(htfDriftPct) < 6 ? 5 : 0;
  breakdown.htfAlignment = htfAlign;
  reasons.push(`24h(1h-bar) drift ${htfDriftPct.toFixed(2)}%`);

  // 7. Liquidity (10) — from snap.meta.volume24hUsd if provided.
  const vol24h = snap.meta && snap.meta.volume24hUsd;
  const liquidityScore = !c.liquidityFilterOn ? 10 : (vol24h == null ? 6 : vol24h >= c.minVolume24hUsd * 3 ? 10 : vol24h >= c.minVolume24hUsd ? 7 : 0);
  breakdown.liquidity = liquidityScore;
  if(vol24h != null) reasons.push(`Est. 24h volume $${Math.round(vol24h).toLocaleString()}`);

  // 8. Fee profitability (5) — can spacing between levels plausibly
  // clear round-trip costs with real room to spare? Checked precisely
  // again at plan-build time (buildGridPlan); this is a coarse pre-check.
  const exchange = (snap.meta && snap.meta.exchange) || 'binance';
  const fees = DEFAULT_FEE_CONFIG[exchange] || DEFAULT_FEE_CONFIG.binance;
  const roundTripFeePct = fees.makerPct * 2; // grid legs are limit orders on both sides when possible
  const spacingHeadroom = rangeWidthPct > 0 ? (rangeWidthPct / 8) : 0; // rough per-level spacing at ~8 levels
  const feeScore = spacingHeadroom >= roundTripFeePct * 3 ? 5 : spacingHeadroom >= roundTripFeePct * 1.5 ? 3 : 0;
  breakdown.feeProfitability = feeScore;

  const score = rangeQuality + trendScore + volScore + srQuality + volScore2 + htfAlign + liquidityScore + feeScore;
  return { score: Math.round(score), breakdown, reasons, regimeOk: true, regime, support, resistance, rangeWidthPct, atrM15, bb, vwapM15, adx1h };
}

// -------------------------------------------------------------
// Grid plan builder — turns a passing suitability score into concrete
// upper/lower boundaries, level prices, spacing, direction, and sizing.
// Returns null if the score doesn't clear the gate (deliberately mirrors
// scoreGridSuitability's own null path — "no trade" is a first-class
// outcome, not an error).
// -------------------------------------------------------------
export function buildGridPlan(symbol, snap, regime, cfg, accountEquity){
  const c = { ...GRID_DEFAULTS, ...cfg };
  const s = scoreGridSuitability(snap, regime, c);
  if(!s.regimeOk || s.score < c.minGridScore) return null;

  const price = snap.price;
  const mid = s.vwapM15 || price;
  // Blend three independent range estimates (ATR-based, Bollinger-based,
  // swing-structure-based) rather than trusting any single one — a
  // single wide-outlier ATR reading or a single stale swing level
  // shouldn't alone dictate the whole grid's boundaries.
  const atrHalfWidth = (s.atrM15 || 0) * 2.2;
  const bbHalfWidth = s.bb ? (s.bb.upper - s.bb.lower) / 2 : atrHalfWidth;
  const swingHalfWidth = (s.resistance - s.support) / 2 || atrHalfWidth;
  let halfWidth = (atrHalfWidth + bbHalfWidth + swingHalfWidth) / 3;
  // Clamp to a sane % of price — never an unbounded or degenerate range.
  const minHalfWidthPct = 0.75, maxHalfWidthPct = 8;
  halfWidth = Math.min(Math.max(halfWidth, mid * minHalfWidthPct / 100), mid * maxHalfWidthPct / 100);

  const upper = mid + halfWidth;
  const lower = mid - halfWidth;

  // Adaptive spacing: wider in higher volatility, narrower in calm
  // conditions, but never so tight that fees/slippage eat the level's
  // own edge (checked precisely per-level below via minNetProfitPct).
  const atrPctOfPrice = s.atrM15 ? (s.atrM15 / mid) * 100 : 1;
  const rawSpacingPct = Math.max(atrPctOfPrice * 0.55, c.minNetProfitPct * 3);
  let levelCount = Math.round(((upper - lower) / mid * 100) / rawSpacingPct) + 1;
  levelCount = Math.min(c.maxGridLevels, Math.max(c.minGridLevels, levelCount || c.defaultGridLevels));
  const spacingPct = ((upper - lower) / mid * 100) / Math.max(1, levelCount - 1);

  const levels = [];
  for(let i = 0; i < levelCount; i++){
    levels.push(lower + (i / Math.max(1, levelCount - 1)) * (upper - lower));
  }

  // Direction: AUTO picks NEUTRAL (both sides) in a true Range regime,
  // or a directional bias (only the side that profits from the weak
  // trend continuing slightly, per spec's "may optionally operate with
  // a directional bias during weak trends") in a weak-trend regime.
  let direction = c.mode;
  if(direction === 'AUTO'){
    if(regime.regime === REGIMES.WEAK_BULL) direction = 'LONG';
    else if(regime.regime === REGIMES.WEAK_BEAR) direction = 'SHORT';
    else direction = 'NEUTRAL';
  }

  const leverage = Math.min(c.maxLeverage, 5);
  const allocationUsd = accountEquity * (c.maxGridAllocationPct / 100);

  return {
    symbol, direction, upper, lower, levels, spacingPct, levelCount,
    gridScore: s.score, scoreBreakdown: s.breakdown, scoreReasons: s.reasons,
    leverage, allocationUsd, minNetProfitPct: c.minNetProfitPct,
    regime: regime.regime, atrM15: s.atrM15, mid,
  };
}

// -------------------------------------------------------------
// Breakout detection — confirmed close beyond the grid boundary, with
// ATR-expansion + volume confirmation (false-breakout filter). Returns
// { breakout: bool, reasons: [] }.
// -------------------------------------------------------------
export function detectGridBreakout(snap, plan, cfg){
  const c = { ...GRID_DEFAULTS, ...cfg };
  const m5 = snap.m5;
  const last = m5[m5.length - 1];
  const atrM5 = atr(m5, 14) || plan.atrM15 || 0;
  const volExp = volumeExpansion(m5, 20);
  const reasons = [];

  const brokeUp = last.c > plan.upper + atrM5 * c.breakoutSensitivityAtr;
  const brokeDown = last.c < plan.lower - atrM5 * c.breakoutSensitivityAtr;
  if(!brokeUp && !brokeDown) return { breakout: false, reasons: [] };

  const volConfirmed = volExp >= c.breakoutVolumeMult;
  if(!volConfirmed){
    return { breakout: false, reasons: [`Price beyond ${brokeUp ? 'upper' : 'lower'} boundary but volume (${volExp.toFixed(2)}x) did not confirm — treated as noise, not a breakout`] };
  }

  reasons.push(`Confirmed candle close ${brokeUp ? 'above upper' : 'below lower'} grid boundary by ${(c.breakoutSensitivityAtr).toFixed(2)}x ATR, volume ${volExp.toFixed(2)}x average`);
  return { breakout: true, direction: brokeUp ? 'UP' : 'DOWN', reasons };
}

// =============================================================
// Shared grid session/stepper — the actual state machine (deploy /
// manage / breakout / liquidation / drift-recalc / daily-halt logic)
// factored out so BOTH runGridBacktest (below, looping over historical
// bars) and the Paper-mode live wiring (futures-ui.js, called once per
// real-time tick) run the EXACT same code path — no separate
// reimplementation to drift out of sync with what was actually tested.
//
// A "session" holds equity/daily-halt state plus one active grid (or
// null) PER SYMBOL, since a real account can run independent grid
// deployments on several symbols at once. Session objects are mutated
// in place by stepGridSymbol — the same convention this codebase's
// `dayState` already uses everywhere else (engine.js/backtest.js).
// =============================================================
export function createGridSession(startingEquity){
  return {
    equity: startingEquity, peakEquity: startingEquity, maxDrawdownPct: 0,
    dayAnchorEquity: startingEquity, currentDayKey: null, dailyHalted: false,
    grids: {}, // symbol -> active grid object, or absent/null
    gridSeq: {}, // symbol -> running deployment counter, for GRID IDs
    counters: { liquidations: 0, emergencyExits: 0, breakoutExits: 0, recalculations: 0, gridCyclesOpened: 0 },
  };
}

function rollGridDay(session, nowMs){
  const key = Math.floor(nowMs / 86_400_000);
  if(session.currentDayKey === key) return;
  session.currentDayKey = key;
  session.dayAnchorEquity = session.equity;
  session.dailyHalted = false;
}

// Advances ONE symbol's grid state by one bar/tick. `bar` is that
// symbol's own {o,h,l,c} for this step (a real historical 5m candle in
// backtest, or the latest aggregated candle from mockMarket/live-feed
// snapshot in Paper/Live). Returns the trades (closed grid cycles/
// exits) generated on this step; mutates `session` in place.
export function stepGridSymbol(session, { symbol, snap, regime, bar, nowMs, cfg, exchange, metaOverrides }){
  const c = { ...GRID_DEFAULTS, ...cfg };
  const stepTrades = [];
  rollGridDay(session, nowMs);
  const dailyPnlPct = ((session.equity - session.dayAnchorEquity) / session.dayAnchorEquity) * 100;

  if(!session.dailyHalted && dailyPnlPct <= -c.maxDailyLossPct) session.dailyHalted = true;
  if(!session.dailyHalted && c.dailyProfitTargetPct && dailyPnlPct >= c.dailyProfitTargetPct) session.dailyHalted = true;

  let grid = session.grids[symbol] || null;

  function closeLeg(leg, exitPrice, exitReason){
    const pnl = netCycleProfit({
      entryPrice: leg.entry, exitPrice, qty: leg.qty, leverage: grid.leverage, direction: leg.direction,
      exchange, holdMinutes: (nowMs - leg.openedAt) / 60_000, fundingRatePct: (metaOverrides && metaOverrides.fundingRatePct) || 0,
      slippagePct: (metaOverrides && metaOverrides.spreadPct) || 0.02,
    });
    session.equity += pnl.netUsd;
    session.peakEquity = Math.max(session.peakEquity, session.equity);
    session.maxDrawdownPct = Math.max(session.maxDrawdownPct, ((session.peakEquity - session.equity) / session.peakEquity) * 100);
    const trade = {
      closedAtMs: nowMs, openedAtMs: leg.openedAt, exchange, symbol, direction: leg.direction,
      entry: leg.entry, exit: exitPrice, qty: leg.qty, leverage: grid.leverage,
      grossUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, slippageUsd: pnl.slippageUsd, netUsd: pnl.netUsd,
      confidence: grid.gridScore, setupType: 'NxTGen Grid', reasonEntry: `Grid level fill @ ${leg.entry.toFixed(6)}`,
      exitReason, durationMin: Math.round((nowMs - leg.openedAt) / 60_000),
      gridId: grid.id, gridLevel: leg.levelIndex, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
    };
    stepTrades.push(trade);
    return pnl;
  }
  function closeAllLegs(exitPrice, exitReason){
    for(const leg of grid.openLegs.slice()) closeLeg(leg, exitPrice, exitReason);
    grid.openLegs = [];
  }

  if(session.dailyHalted && grid){
    // Daily loss/profit gate just tripped (or already was tripped) —
    // only force-close on the LOSS side, exactly like the backtest path;
    // a profit-target halt just stops opening NEW grids (handled below).
    if(dailyPnlPct <= -c.maxDailyLossPct){
      closeAllLegs(bar.c, 'DAILY_LOSS_LIMIT');
      grid = null;
    }
  }

  if(grid){
    const bo = detectGridBreakout(snap, grid, c);
    if(bo.breakout){
      closeAllLegs(bar.c, 'BREAKOUT_EXIT');
      session.counters.breakoutExits++;
      grid = null;
    } else {
      for(const leg of grid.openLegs.slice()){
        const liq = estimateLiquidationPrice({ entryPrice: leg.entry, leverage: grid.leverage, side: leg.direction, maintenanceMarginRate: 0.5 });
        const dist = Math.abs(bar.c - liq);
        const worstCase = Math.abs(leg.entry - (leg.direction === 'LONG' ? grid.lower : grid.upper));
        if(dist < worstCase * c.liquidationBufferRatio * 0.35){
          closeLeg(leg, bar.c, 'LIQUIDATION_RISK_EXIT');
          grid.openLegs = grid.openLegs.filter(l => l !== leg);
          session.counters.liquidations++;
        }
      }
      const gridUnrealizedFloorUsd = -grid.allocationUsd * (c.maxGridLossPct / 100);
      if(grid && grid.realizedUsd < gridUnrealizedFloorUsd){
        closeAllLegs(bar.c, 'EMERGENCY_EXIT');
        session.counters.emergencyExits++;
        grid = null;
      }
    }
  }

  if(grid){
    const perLevelUsd = grid.allocationUsd / grid.levelCount;
    for(let li = 0; li < grid.levels.length; li++){
      if(grid.filledLevel[li]) continue;
      const levelPrice = grid.levels[li];
      const crossed = bar.l <= levelPrice && bar.h >= levelPrice;
      if(!crossed) continue;
      const isLowerHalf = levelPrice <= grid.mid;
      const wantLong = (grid.direction === 'LONG' || grid.direction === 'NEUTRAL') && isLowerHalf;
      const wantShort = (grid.direction === 'SHORT' || grid.direction === 'NEUTRAL') && !isLowerHalf;
      if(!wantLong && !wantShort) continue;
      if(grid.openLegs.length >= c.maxGridLevels) continue;
      const direction = wantLong ? 'LONG' : 'SHORT';
      const qty = perLevelUsd * grid.leverage / levelPrice;
      grid.filledLevel[li] = true;
      grid.openLegs.push({ levelIndex: li, entry: levelPrice, qty, direction, openedAt: nowMs, targetIndex: wantLong ? li + 1 : li - 1 });
    }

    for(const leg of grid.openLegs.slice()){
      const targetPrice = grid.levels[leg.targetIndex];
      if(targetPrice == null) continue;
      const reached = leg.direction === 'LONG' ? bar.h >= targetPrice : bar.l <= targetPrice;
      if(!reached) continue;
      const check = netCycleProfit({
        entryPrice: leg.entry, exitPrice: targetPrice, qty: leg.qty, leverage: grid.leverage, direction: leg.direction,
        exchange, holdMinutes: (nowMs - leg.openedAt) / 60_000, fundingRatePct: (metaOverrides && metaOverrides.fundingRatePct) || 0,
        slippagePct: (metaOverrides && metaOverrides.spreadPct) || 0.02,
      });
      if(check.netPct < grid.minNetProfitPct) continue;
      const pnl = closeLeg(leg, targetPrice, 'GRID_CYCLE_TP');
      grid.realizedUsd += pnl.netUsd;
      grid.openLegs = grid.openLegs.filter(l => l !== leg);
      grid.filledLevel[leg.levelIndex] = false;
      session.counters.gridCyclesOpened++;
    }

    const halfWidth = (grid.upper - grid.lower) / 2;
    const driftUp = bar.c > grid.upper + halfWidth * (c.recalcDriftPct / 100);
    const driftDown = bar.c < grid.lower - halfWidth * (c.recalcDriftPct / 100);
    if((driftUp || driftDown) && grid){
      closeAllLegs(bar.c, 'GRID_RECALCULATION');
      session.counters.recalculations++;
      grid = null;
    }
  }

  if(!grid && !session.dailyHalted){
    const plan = buildGridPlan(symbol, snap, regime, c, session.equity);
    if(plan){
      session.gridSeq[symbol] = (session.gridSeq[symbol] || 0) + 1;
      const d = new Date(nowMs);
      const dateKey = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      grid = {
        id: `GRID-${symbol.replace('USDT', '')}-${dateKey}-${String(session.gridSeq[symbol]).padStart(3, '0')}`,
        ...plan, openLegs: [], filledLevel: new Array(plan.levels.length).fill(false), realizedUsd: 0, openedAt: nowMs,
      };
    }
  }

  session.grids[symbol] = grid;
  return stepTrades;
}

// Force-closes every symbol's active grid at that symbol's own last
// known price — used at the end of a backtest range (mark-to-market)
// and available for a Paper/Live "flatten all Grid positions" action.
export function closeAllGridSessions(session, priceBySymbol, nowMs, exchange, metaOverrides){
  const trades = [];
  for(const symbol of Object.keys(session.grids)){
    const grid = session.grids[symbol];
    if(!grid || !grid.openLegs.length) continue;
    const price = priceBySymbol[symbol];
    if(price == null) continue;
    for(const leg of grid.openLegs.slice()){
      const pnl = netCycleProfit({
        entryPrice: leg.entry, exitPrice: price, qty: leg.qty, leverage: grid.leverage, direction: leg.direction,
        exchange, holdMinutes: (nowMs - leg.openedAt) / 60_000, fundingRatePct: (metaOverrides && metaOverrides.fundingRatePct) || 0,
        slippagePct: (metaOverrides && metaOverrides.spreadPct) || 0.02,
      });
      session.equity += pnl.netUsd;
      trades.push({
        closedAtMs: nowMs, openedAtMs: leg.openedAt, exchange, symbol, direction: leg.direction,
        entry: leg.entry, exit: price, qty: leg.qty, leverage: grid.leverage,
        grossUsd: pnl.grossUsd, feesUsd: pnl.feesUsd, fundingUsd: pnl.fundingUsd, slippageUsd: pnl.slippageUsd, netUsd: pnl.netUsd,
        confidence: grid.gridScore, setupType: 'NxTGen Grid', reasonEntry: `Grid level fill @ ${leg.entry.toFixed(6)}`,
        exitReason: 'MANUAL_FLATTEN', durationMin: Math.round((nowMs - leg.openedAt) / 60_000),
        gridId: grid.id, gridLevel: leg.levelIndex, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
      });
    }
    grid.openLegs = [];
    session.grids[symbol] = grid;
  }
  return trades;
}

// -------------------------------------------------------------
// Fee-aware per-level net profit check. A grid leg is only counted
// profitable, and only closed as such, if NET (gross - entry fee - exit
// fee - slippage - funding accrued) clears minNetProfitPct. This is the
// gate described in the spec's "FEE-AWARE GRID" section.
// -------------------------------------------------------------
export function netCycleProfit({ entryPrice, exitPrice, qty, leverage, direction, exchange, holdMinutes, fundingRatePct, slippagePct }){
  const fees = DEFAULT_FEE_CONFIG[exchange] || DEFAULT_FEE_CONFIG.binance;
  const notional = entryPrice * qty;
  const sign = direction === 'LONG' ? 1 : -1;
  const grossPct = ((exitPrice - entryPrice) / entryPrice) * sign * 100;
  const grossUsd = notional * (grossPct / 100);
  const entryFeeUsd = notional * (fees.makerPct / 100);
  const exitFeeUsd = (exitPrice * qty) * (fees.makerPct / 100); // both legs assumed maker/limit fills — the whole point of resting grid orders
  const slippageUsd = notional * ((slippagePct || 0) / 100);
  const fundingPeriods = Math.max(0, holdMinutes || 0) / (8 * 60);
  const fundingUsd = notional * Math.abs(fundingRatePct || 0) / 100 * fundingPeriods;
  const feesUsd = entryFeeUsd + exitFeeUsd;
  const netUsd = grossUsd - feesUsd - slippageUsd - fundingUsd;
  const netPct = notional ? (netUsd / notional) * 100 : 0;
  return { grossUsd, feesUsd, slippageUsd, fundingUsd, netUsd, netPct };
}

// =============================================================
// runGridBacktest — standalone grid simulator over ONE symbol's own
// chronological candle series. Deliberately separate from
// js/futures/backtest.js's runBacktest (which drives the six
// STRATEGY_REGISTRY detectors' single-entry/TP-ladder model across a
// SHARED multi-symbol timeline) — a grid deployment's state (which
// levels are filled, current boundaries, whether it's paused) is
// per-symbol and doesn't fit that shared loop's position shape. It is
// called once per selected symbol from backtest-ui.js and its resulting
// trades are merged into the same overall trade list/equity accounting
// the other six strategies use, so results/Trade Log/CSV export all
// still work identically for NxTGen Grid rows.
//
// No lookahead: identical discipline to backtest.js — every regime/plan
// evaluation at bar i only ever sees candles[0..i], and each bar's own
// fills are checked against that bar's real high/low before moving to
// the next chronological bar. Internally this is now a thin loop around
// stepGridSymbol above — the exact same function Paper mode's live tick
// calls (see futures-ui.js's runGridPaperTick) — so backtest and Paper
// can never silently drift apart in what the strategy actually does.
// =============================================================
export function runGridBacktest({ symbol, candles, cfg, startingEquity, exchange, metaOverrides, intervalMinutes }){
  const c = { ...GRID_DEFAULTS, ...cfg };
  const barMin = intervalMinutes || 5;
  const m15Group = Math.max(1, Math.round(15 / barMin));
  const h1Group = Math.max(1, Math.round(60 / barMin));

  function aggregate(uptoIndex, groupSize, count){
    const out = [];
    for(let end = uptoIndex + 1; end > 0 && out.length < count; end -= groupSize){
      const start = Math.max(0, end - groupSize);
      const slice = candles.slice(start, end);
      if(!slice.length) continue;
      out.unshift({ t: slice[0].t, o: slice[0].o, h: Math.max(...slice.map(x => x.h)), l: Math.min(...slice.map(x => x.l)), c: slice[slice.length - 1].c, v: slice.reduce((a, x) => a + x.v, 0) });
    }
    return out;
  }
  function snapshotAt(i){
    const barsPerDay = 1440 / barMin;
    return {
      symbol, price: candles[i].c,
      m5: candles.slice(Math.max(0, i - 119), i + 1),
      m15: aggregate(i, m15Group, 120),
      h1: aggregate(i, h1Group, 60),
      meta: { ...metaOverrides, exchange, volume24hUsd: (candles[i].v || 0) * barsPerDay * candles[i].c },
    };
  }

  const warmup = Math.max(30 * m15Group, 30 * h1Group) + 20;
  const session = createGridSession(startingEquity);
  const trades = [];
  const equityCurve = [];

  for(let i = warmup; i < candles.length; i++){
    const nowMs = candles[i].t;
    const snap = snapshotAt(i);
    const regime = classifyRegime(snap.h1, snap.m15);
    const stepTrades = stepGridSymbol(session, { symbol, snap, regime, bar: candles[i], nowMs, cfg: c, exchange, metaOverrides });
    trades.push(...stepTrades);
    equityCurve.push({ t: nowMs, equity: session.equity });
  }

  if(candles.length){
    const last = candles[candles.length - 1];
    const closing = closeAllGridSessions(session, { [symbol]: last.c }, last.t, exchange, metaOverrides);
    for(const t of closing) t.exitReason = 'OPEN_AT_END'; // mark-to-market close at data end, not a manual flatten
    trades.push(...closing);
  }

  return { trades, equityCurve, counters: session.counters, finalEquity: session.equity, maxDrawdownPct: session.maxDrawdownPct, symbol };
}

// Grid-specific summary, distinguishing grid-cycle stats from generic
// trade stats (spec explicitly calls out these are not necessarily the
// same thing — in THIS implementation every closed row IS one full
// buy-then-sell (or sell-then-buy) grid cycle, so trade count and cycle
// count coincide here; kept as separate named fields regardless so the
// UI/report can label them correctly and this stays true if the fill
// model ever changes to allow multi-leg cycles).
export function summarizeGridTrades(trades, startingEquity, counters){
  const cycles = trades.length;
  // NET-based (after fees/slippage/funding), matching summarizeTrades'
  // methodology in backtest.js exactly — this used to classify wins/
  // losses and compute profit factor from raw grossUsd (pre-cost), which
  // produced a different, contradictory profit factor than the overall
  // stat cards for the exact same trades (cost drag pushes real profit
  // factor below the gross-only figure). Net P&L is what actually
  // happened; gross is tracked below only as a separate informational
  // figure, not as the basis for win/loss or profit factor.
  const wins = trades.filter(t => t.netUsd > 0);
  const losses = trades.filter(t => t.netUsd <= 0);
  const grossProfitRaw = trades.reduce((a, t) => a + Math.max(0, t.grossUsd), 0);
  const grossLossRaw = Math.abs(trades.reduce((a, t) => a + Math.min(0, t.grossUsd), 0));
  const netProfit = wins.reduce((a, t) => a + t.netUsd, 0);
  const netLoss = Math.abs(losses.reduce((a, t) => a + t.netUsd, 0));
  const netUsd = trades.reduce((a, t) => a + t.netUsd, 0);
  const feesUsd = trades.reduce((a, t) => a + t.feesUsd, 0);
  const fundingUsd = trades.reduce((a, t) => a + (t.fundingUsd || 0), 0);
  const slippageUsd = trades.reduce((a, t) => a + (t.slippageUsd || 0), 0);
  const winRate = cycles ? (wins.length / cycles) * 100 : 0;
  const profitFactor = netLoss > 0 ? netProfit / netLoss : (netProfit > 0 ? Infinity : 0);
  const avgWinUsd = wins.length ? netProfit / wins.length : 0;
  const avgLossUsd = losses.length ? -netLoss / losses.length : 0;
  const expectancyUsd = cycles ? netUsd / cycles : 0;
  const largestLossUsd = losses.length ? Math.min(...losses.map(t => t.netUsd)) : 0;
  const durations = trades.map(t => t.durationMin);
  const avgDurationMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  return {
    gridCycles: cycles, tradeWinRate: winRate, gridCycleWinRate: winRate, // see comment above
    grossProfit: grossProfitRaw, grossLoss: grossLossRaw, netUsd, feesUsd, fundingUsd, slippageUsd,
    profitFactor, avgWinUsd, avgLossUsd, largestLossUsd, expectancyUsd, avgDurationMin,
    netReturnPct: startingEquity ? (netUsd / startingEquity) * 100 : 0,
    liquidations: counters.liquidations, emergencyExits: counters.emergencyExits,
    breakoutExits: counters.breakoutExits, recalculations: counters.recalculations,
  };
}
