// =============================================================
// botEngine.js — the Trading Bots (Grid + DCA, manual and Smart) running on the SERVER.
//
// Why: the bot manager used to live in the browser (js/futures-ui.js), so closing the
// tab stopped it — nothing re-placed grid levels, topped up DCA safety orders or checked
// profit targets. Here the SAME management logic runs on a timer inside the always-on
// server process, driven by bots persisted in botVault.js and the SHARED API keys saved
// there. The browser just creates/stops bots and mirrors their state.
//
// The deploy/manage/flatten/daily-limit functions below are lifted from futures-ui.js
// UNCHANGED (only the browser plumbing around them is swapped for the server versions in
// the "server plumbing" block), so a bot behaves the same wherever it runs. If you change
// that logic in the browser, mirror it here.
//
// Exchange access: the engine talks to this server's own /api/futures/* routes (the very
// same calls the browser makes) through the injected callProxy, so every exchange
// integration stays in one place.
// =============================================================
import { GRID_DEFAULTS, detectGridBreakout, buildManualGridPlan, suggestGridRange, netCycleProfit } from '../js/futures/grid.js';
import { buildDcaPlan, computeDcaExitPrices } from '../js/futures/dca.js';
import { estimateLiquidationPrice, RISK_DEFAULTS } from '../js/futures/risk.js';
import { classifyRegime } from '../js/futures/regime.js';
import { isDuplicateBotTrade, dedupeBotTrades } from '../js/futures/tradeLedger.js';

export const BOT_EXCHANGES = ['bybit', 'binance'];
// Exchanges whose API keys can be saved (encrypted) on an account. Wider than BOT_EXCHANGES: the 24/7 bot engine only trades Bybit/Binance,
// but every exchange the proxy can verify/trade on may keep its key on the server instead of in the browser.
export const KEY_EXCHANGES = ['bybit', 'binance', 'bitget', 'mexc', 'gateio'];
const MAX_TRADES = 3000;
const GAP_NOTICE_MS = 3 * 60_000;

export function createBotEngine({ store, callProxy, fetchSnapshot, log = console, cycleMs = 8000 }){
  const S = store.state;
  let cycleBusy = false, timer = null;
  const deploying = new Map(); // bot id -> promise, so tests (and shutdown) can await an in-flight deploy

  // ---------------- server plumbing (replaces the browser's DOM/state layer) ----------------
  const EXCHANGE_DISPLAY_NAMES = { bybit: 'Bybit', binance: 'Binance' };
  const window = { confirm: () => false }; // nobody is there to answer a prompt; the prompt-guarded branches treat that as "no"
  const fu = () => S;
  const liveCred = (exchange, mode) => store.getCred(exchange, mode);
  const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`;
  const fmtUsd = (n) => `${Number(n || 0) < 0 ? '-' : '+'}$${Math.abs(Number(n || 0)).toFixed(2)}`;
  const renderTradingBotsList = () => store.touch(); // the browser re-renders here; the server just persists

  function tradingBotLog(bot, msg, isError){
    bot.statusMessage = msg;
    bot.statusIsError = !!isError;
    bot.log = bot.log || [];
    const last = bot.log[bot.log.length - 1];
    // the per-cycle "Running — ..." heartbeat would otherwise flood the history: keep only the latest of a repeated kind
    if(last && !isError && !last.err && /^Running/.test(msg) && /^Running/.test(last.msg)) bot.log.pop();
    bot.log.push({ t: Date.now(), msg, err: !!isError });
    if(bot.log.length > 80) bot.log.splice(0, bot.log.length - 80);
    store.touch();
  }

  // Returns true when a NEW row was written, false when the same bot trade is already stored (see
  // js/futures/tradeLedger.js). bookBotTrade only adds P&L to the bot / daily counters on true.
  function appendPersistentTrade(record){
    if(isDuplicateBotTrade(S.trades, record)) return false;
    S.trades.unshift({ id: `${record.closedAtMs || Date.now()}_${record.symbol || ''}_${Math.random().toString(36).slice(2, 9)}`, ...record });
    if(S.trades.length > MAX_TRADES) S.trades.length = MAX_TRADES;
    store.touch();
    return true;
  }

  // The ONE way a bot close is booked — row first, P&L counted only if the row is new.
  function bookBotTrade(bot, record){
    if(!appendPersistentTrade(record)) return false;
    const net = Number(record.netUsd) || 0;
    bot.realizedUsd = (bot.realizedUsd || 0) + net;
    addTradingBotsRealized(net);
    return true;
  }

  // ---------------- lifted from js/futures-ui.js (unchanged) ----------------
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

  // -------------------------------------------------------------
  // Futures Grid bot — deployment + ongoing management. Reuses the EXACT
  // same order-placement calls NxTGen Grid Live/Demo already uses
  // (place-level/place-close/set-side-stop/flatten/orders/ensure-mode),
  // just against this bot's OWN manually-built plan/levels instead of the
  // single global gridLiveState — several of these can run at once, one
  // per bot instance, each fully independent.
  // -------------------------------------------------------------
  async function deployGridBotInstance(bot, cred){
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    let modeCheck = await callProxy('/api/futures/grid/ensure-mode', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    // Binance Demo only: offer to flip the Demo account to Hedge Mode (a manual deploy only \u2014 an auto-scan
    // deploy has nobody there to answer, so it just reports the error).
    if(modeCheck.ok && modeCheck.hedgeModeReady === false && modeCheck.canAutoSwitch && !(bot.config && bot.config.autoScan)){
      const yes = window.confirm('Your Binance Demo account is in one-way position mode, but grid bots need Hedge Mode.\n\nSwitch the Demo account to Hedge Mode now? It applies to the whole Demo account, and Binance only allows it while that account has no open positions or open orders.');
      if(yes){
        const sw = await callProxy('/api/futures/grid/set-hedge-mode', proxyArgs).catch(err => ({ ok:false, message: err.message }));
        if(sw.ok) modeCheck = await callProxy('/api/futures/grid/ensure-mode', proxyArgs).catch(err => ({ ok:false, message: err.message }));
        else modeCheck = { ok:true, hedgeModeReady:false, message: sw.message };
      }
    }
    if(!modeCheck.ok || modeCheck.hedgeModeReady === false){
      bot.status = 'error';
      tradingBotLog(bot, modeCheck.message || `Could not confirm hedge mode for ${bot.symbol} on ${bot.exchange}.`, true);
      return;
    }
    const plan = bot.plan;
    const levels = [];
    for(let li = 0; li < plan.levels.length; li++){
      const levelPrice = plan.levels[li];
      const isLowerHalf = levelPrice <= plan.mid;
      const wantLong = (plan.direction === 'LONG' || plan.direction === 'NEUTRAL') && isLowerHalf;
      const wantShort = (plan.direction === 'SHORT' || plan.direction === 'NEUTRAL') && !isLowerHalf;
      if(!wantLong && !wantShort) continue;
      const direction = wantLong ? 'LONG' : 'SHORT';
      const perLevelUsd = plan.allocationUsd / plan.levelCount;
      const qty = (perLevelUsd * plan.leverage) / levelPrice;
      const placed = await callProxy('/api/futures/grid/place-level', { ...proxyArgs, direction, price: levelPrice, qty, leverage: plan.leverage, orderLinkTag: `${bot.id}-${li}`, stopLoss: direction === 'LONG' ? plan.lower : plan.upper }).catch(err => ({ ok:false, message: err.message }));
      if(!placed.ok){ tradingBotLog(bot, `Level ${li} (${levelPrice.toFixed(6)}) skipped: ${placed.message}`, false); continue; }
      levels.push({ levelIndex: li, price: levelPrice, direction, status: 'PENDING_ENTRY', entryOrderId: placed.orderId, targetIndex: wantLong ? li + 1 : li - 1 });
    }
    if(levels.length === 0){
      bot.status = 'error';
      tradingBotLog(bot, 'No grid levels could be placed — see messages above.', true);
      return;
    }
    bot.runtime.levels = levels;
    bot.runtime.openedAtMs = Date.now();
    bot.runtime.unrealizedUsd = null; // set for real on the first management tick
    bot.status = 'active';
    tradingBotLog(bot, `Grid ACTIVE — ${levels.length}/${plan.levelCount} levels resting.`, false);
  }

  // -------------------------------------------------------------
  // Grid Recovery / averaging — an OPTIONAL, off-by-default add-on for
  // Smart Bots' Grid type (bot.config.recoveryMode; manual Trading Bots
  // grids never set this, so they're unaffected). Same idea as DCA's
  // safety-order ladder, bolted onto Grid instead of run as a separate
  // bot type: once this bot's floating equity has drawn down past
  // recoveryTriggerPct — compounding per add, so the 2nd add needs
  // roughly 2x the drawdown the 1st did — it opens ONE MORE market entry
  // on whichever side is actually underwater (the side with more open
  // legs), sized recoverySizeMult times bigger than the last add. That
  // grows the position and shifts the blended average toward the
  // current price, which can turn a smaller bounce into breakeven/profit
  // sooner than waiting on the grid's own cycle alone.
  //
  // Worth being direct about the trade-off: this is a martingale-style
  // average-down. It commits MORE margin to a bot that is already
  // losing, in exchange for a shot at a smaller loss or none at all — it
  // does not make the bot "safer", and a market that keeps moving
  // against it just makes each add bigger. Stop Loss (bot.config.
  // maxLossPct, checked right after this runs) is what actually bounds
  // the worst case; recovery adding never raises, disables, or delays it.
  // -------------------------------------------------------------
  async function applyGridRecovery(bot, plan, snap, proxyArgs){
    const cfg = bot.config;
    if(!cfg?.recoveryMode || bot.status !== 'active') return;
    const rt = bot.runtime;
    if(rt.recoveryAddsUsed == null) rt.recoveryAddsUsed = 0;
    const addsUsed = rt.recoveryAddsUsed;
    const maxAdds = cfg.maxRecoveryAdds || 3;
    if(addsUsed >= maxAdds) return;

    const uPnl = rt.unrealizedUsd || 0;
    const equityUsd = (bot.investmentUsd || 0) + (rt.recoveryAddedUsd || 0);
    const drawdownPct = equityUsd ? (uPnl / equityUsd) * 100 : 0;
    const triggerPct = -(Math.abs(cfg.recoveryTriggerPct || 15)) * (addsUsed + 1);
    if(drawdownPct > triggerPct) return; // not underwater enough yet for the NEXT add

    const openLegs = rt.levels.filter(l => l.status === 'PENDING_CLOSE');
    if(!openLegs.length) return; // nothing open to average against
    const longCount = openLegs.filter(l => l.direction === 'LONG').length;
    const direction = longCount >= (openLegs.length - longCount) ? 'LONG' : 'SHORT';

    const baseLevelUsd = plan.allocationUsd / plan.levelCount;
    const addUsd = baseLevelUsd * Math.pow(cfg.recoverySizeMult || 1.5, addsUsed + 1);
    const qty = (addUsd * plan.leverage) / snap.price;
    const placed = await callProxy('/api/futures/dca/place', { ...proxyArgs, direction, orderType: 'MARKET', qty, leverage: plan.leverage, botTag: bot.id, role: 'add' }).catch(err => ({ ok:false, message: err.message }));
    if(!placed.ok){ tradingBotLog(bot, `Recovery add #${addsUsed + 1} failed: ${placed.message}`, true); return; }
    rt.recoveryAddsUsed = addsUsed + 1;
    rt.recoveryAddedUsd = (rt.recoveryAddedUsd || 0) + addUsd;
    bot.investmentUsd = (bot.investmentUsd || 0) + addUsd; // Max Loss/Profit Target % below are read off bot.investmentUsd, so they recalculate against this larger base automatically
    fu().tbDayAnchorInvestmentUsd += addUsd; // keep the cross-bot daily cap's denominator honest about total capital actually committed
    tradingBotLog(bot, `Recovery add #${addsUsed}/${maxAdds} — added ~${fmtMoney(addUsd)} ${direction} at market (floating drawdown was ${drawdownPct.toFixed(1)}%). Investment now ${fmtMoney(bot.investmentUsd)}.`, false);
  }

  // Resolves ONE closed grid cycle's real net P&L from Bybit itself,
  // instead of trusting grid.js's netCycleProfit() estimate. The estimate
  // only ever modeled THIS level's own entry/exit against an assumed
  // maker/maker fee pair — Bybit nets a hedge-mode close against the
  // position's AVERAGE entry and whatever fee tier the fill actually got,
  // so the two numbers can diverge per-row even when their totals agree
  // (see exchangeCheckHtml). This looks the just-filled close order up by
  // its exact orderId in Bybit's own closed-P&L list (already net of real
  // fees) and uses THAT as netUsd when found. Only Bybit is wired up
  // (getBinanceClosedPnlUnsupported server-side covers the rest) and the
  // lookup can occasionally miss if Bybit hasn't indexed the fill yet the
  // instant this runs — both cases fall back to the estimate, clearly
  // tagged via pnlSource so the UI/log can show which one a row got.
  async function resolveGridCyclePnl(proxyArgs, orderId, estimate){
    if(proxyArgs.exchange !== 'bybit') return { ...estimate, pnlSource: 'estimate' };
    const resp = await callProxy('/api/futures/grid/closed-pnl', proxyArgs).catch(() => null);
    const row = resp && resp.ok ? (resp.list || []).find(r => String(r.orderId) === String(orderId)) : null;
    if(!row) return { ...estimate, pnlSource: 'estimate' };
    // Bybit's closedPnl is already net of both real fees — don't also
    // subtract the estimate's modeled fees/slippage/funding on top of it.
    return { grossUsd: row.feesUsd != null ? row.closedPnl + row.feesUsd : null, feesUsd: row.feesUsd != null ? row.feesUsd : null, fundingUsd: null, slippageUsd: null, netUsd: row.closedPnl, avgEntryPrice: row.avgEntryPrice || null, avgExitPrice: row.avgExitPrice || null, qty: row.qty || null, closedAtMs: row.createdTime || null, pnlSource: 'exchange' };
  }

  // Books Bybit closed-P&L rows into a grid bot, each row at most once (tracked in
  // bot.runtime.claimedPnl). Row `side` is the CLOSING side: Sell closes a long, Buy closes a short.
  // A row matching a level's resting TP is labelled a normal cycle TP; anything else (a flatten, a
  // stop-out) gets `defaultReason`. Used when the bot flattens and by "Add missing closes".
  function bookGridCloseRows(bot, rows, defaultReason){
    bot.runtime.claimedPnl = bot.runtime.claimedPnl || [];
    const claimed = new Set(bot.runtime.claimedPnl.map(String));
    const levelByClose = new Map((bot.runtime.levels || []).filter(l => l.closeOrderId != null).map(l => [String(l.closeOrderId), l]));
    let total = 0, count = 0;
    for(const r of rows){
      const id = String(r.orderId);
      if(claimed.has(id)) continue;
      claimed.add(id); bot.runtime.claimedPnl.push(id);
      const lvl = levelByClose.get(id);
      const direction = r.side === 'Sell' ? 'LONG' : 'SHORT';
      const net = Number(r.closedPnl) || 0;
      const closedAt = r.createdTime || Date.now();
      total += net; count++;
      bookBotTrade(bot, {
        closedAtMs: closedAt, openedAtMs: lvl && lvl.openedAt ? lvl.openedAt : null, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: direction, direction,
        entry: r.avgEntryPrice, exit: r.avgExitPrice, qty: r.qty, leverage: bot.plan?.leverage ?? null,
        grossUsd: r.feesUsd != null ? net + Math.abs(r.feesUsd) : null, feesUsd: r.feesUsd != null ? Math.abs(r.feesUsd) : null, feesReal: r.feesUsd != null, fundingUsd: null, slippageUsd: null, netUsd: net, pnlSource: 'exchange',
        closeOrderId: r.orderId, entryOrderId: lvl ? lvl.entryOrderId : null,
        confidence: null, setupType: 'Trading Bot: Grid', exitReason: lvl ? 'GRID_CYCLE_TP' : defaultReason,
        durationMin: lvl && lvl.openedAt ? Math.max(0, Math.round((closedAt - lvl.openedAt) / 60_000)) : null,
        gridId: bot.id, gridLevel: lvl ? lvl.levelIndex : null, cycleResult: net > 0 ? 'WIN' : 'LOSS',
      });
    }
    if(bot.runtime.claimedPnl.length > 400) bot.runtime.claimedPnl.splice(0, bot.runtime.claimedPnl.length - 300);
    return { total, count };
  }

  // Flattens a grid bot AND books what actually happened. The old flow only called /grid/flatten and
  // marked the bot closed, so the closing trade (often the biggest loss: every open leg market-closed
  // at once) never reached the bot's Realized figure, trade list or daily totals. Now, on Bybit, the
  // real closed-P&L rows are read back (waiting a few seconds for Bybit to index them) and booked; any
  // TP that filled since the last check but was never processed is swept up in the same pass. Other
  // exchanges have no closed-P&L lookup wired up, so they fall back to the floating P&L read just
  // before the flatten (an estimate that leaves out the closing fee).
  async function flattenGridBot(bot, proxyArgs, exitReason){
    let hadOpen = (bot.runtime.levels || []).some(l => l.status === 'PENDING_CLOSE'), unrealized = 0, posKnown = false;
    const pos = await callProxy('/api/futures/grid/positions', proxyArgs).catch(() => ({ ok:false }));
    if(pos.ok){ posKnown = true; hadOpen = (pos.long?.size > 0) || (pos.short?.size > 0); unrealized = (pos.long?.unrealisedPnl || 0) + (pos.short?.unrealisedPnl || 0); }
    const tFlat = Date.now();
    const flat = await callProxy('/api/futures/grid/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!flat.ok) return { ok:false, message: flat.message, hadOpen, total: 0, count: 0 };

    let total = 0, count = 0, sawFlattenRow = false;
    if(bot.exchange === 'bybit'){
      for(let attempt = 0; attempt < 6; attempt++){
        const r = await callProxy('/api/futures/grid/closed-pnl', proxyArgs).catch(() => null);
        const claimed = new Set((bot.runtime.claimedPnl || []).map(String));
        const fresh = r && r.ok ? (r.list || []).filter(x => x.createdTime >= (bot.createdAtMs || 0) - 60_000 && !claimed.has(String(x.orderId))) : [];
        sawFlattenRow = fresh.some(x => x.createdTime >= tFlat - 15_000);
        if(sawFlattenRow || !hadOpen || attempt === 5){
          if(fresh.length){ const b = bookGridCloseRows(bot, fresh, exitReason); total += b.total; count += b.count; }
          break;
        }
        await sleepMs(2000);
      }
    } else if(hadOpen && posKnown){
      total = unrealized; count = 1;
      bookBotTrade(bot, {
        closedAtMs: Date.now(), exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: bot.direction || 'GRID', netUsd: unrealized, pnlSource: 'estimate',
        leverage: bot.plan?.leverage ?? null, setupType: 'Trading Bot: Grid', exitReason: `${exitReason}_EST`, gridId: bot.id,
      });
    }
    return { ok:true, hadOpen, total, count, missing: hadOpen && bot.exchange === 'bybit' && !sawFlattenRow };
  }

  function logGridFlattenResult(bot, res){
    if(!res.hadOpen && !res.count) return;
    const ex = EXCHANGE_DISPLAY_NAMES[bot.exchange] || bot.exchange;
    if(res.missing) tradingBotLog(bot, `Flattened, but ${ex} hasn\u2019t listed the closing trade yet \u2014 open this bot and press Verify with ${ex}, then Add missing closes, to book it.`, true);
    else tradingBotLog(bot, `Flattened \u2014 ${res.count} close(s) booked${bot.exchange === 'bybit' ? ' from Bybit' : ' (estimated from floating P&L)'}, ${fmtUsd(res.total)} net.`, res.total < 0);
  }

  async function manageGridBotInstance(bot, cred, nowMs){
    const plan = bot.plan;
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    const snap = await fetchSnapshot(bot.exchange, bot.symbol, '5m').catch(err => { tradingBotLog(bot, `Snapshot fetch failed: ${err.message}`, true); return null; });
    if(!snap) return;
    bot.runtime.markPrice = snap.price; // last known mark, for the Details view's Parameters block

    const bo = detectGridBreakout(snap, plan, GRID_DEFAULTS);
    if(bo.breakout){
      tradingBotLog(bot, `BREAKOUT detected (${bo.reasons[0] || ''}) — flattening.`, true);
      const flat = await flattenGridBot(bot, proxyArgs, 'GRID_FLATTEN_BREAKOUT');
      if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      else logGridFlattenResult(bot, flat);
      bot.status = 'closed'; bot.stoppedAtMs = Date.now();
      renderTradingBotsList();
      return;
    }

    // Drift recalculation — price has wandered well beyond this grid's own
    // range WITHOUT a confirmed breakout (detectGridBreakout above requires
    // ATR-expansion + volume confirmation, so a slow, unconfirmed grind
    // can sit outside the range for a while without ever tripping it).
    // Ported from NxTGen Grid's stepGridSymbol — same recalcDriftPct
    // threshold — because without this, a Trading Bots grid left running
    // through a slow drift just keeps quoting a range the market has
    // already left, one-sided and unmanaged, with no auto-correction.
    const halfWidth = (plan.upper - plan.lower) / 2;
    const driftedUp = snap.price > plan.upper + halfWidth * (GRID_DEFAULTS.recalcDriftPct / 100);
    const driftedDown = snap.price < plan.lower - halfWidth * (GRID_DEFAULTS.recalcDriftPct / 100);
    if(driftedUp || driftedDown){
      tradingBotLog(bot, `Price drifted ${GRID_DEFAULTS.recalcDriftPct}%+ beyond the grid range without a confirmed breakout — flattening (stale range).`, true);
      const flat = await flattenGridBot(bot, proxyArgs, 'GRID_FLATTEN_STALE');
      if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      else logGridFlattenResult(bot, flat);
      bot.status = 'closed'; bot.stoppedAtMs = Date.now();
      renderTradingBotsList();
      return;
    }

    // Liquidation-buffer protection — ported from stepGridSymbol's
    // liquidationBufferRatio check. If ANY currently-open leg's estimated
    // liquidation price has drifted uncomfortably close to the current
    // mark, flatten NOW rather than wait for that leg to either hit its
    // target or for a confirmed breakout. One real difference from NxTGen
    // Grid's version: this app's exchange proxy only exposes a
    // whole-symbol flatten (both hedge-mode sides at once, via
    // /api/futures/grid/flatten) — there's no reduce-only single-side
    // close endpoint yet — so this closes the WHOLE bot, not just the
    // at-risk leg. More conservative than the simulated version, on
    // purpose, given what's actually available to call right now.
    const openLegs = bot.runtime.levels.filter(l => l.status === 'PENDING_CLOSE');
    for(const leg of openLegs){
      const liqPrice = estimateLiquidationPrice({ entryPrice: leg.entryPrice, leverage: plan.leverage, side: leg.direction, maintenanceMarginRate: RISK_DEFAULTS.maintenanceMarginRate });
      const dist = Math.abs(snap.price - liqPrice);
      const worstCase = Math.abs(leg.entryPrice - (leg.direction === 'LONG' ? plan.lower : plan.upper));
      if(worstCase > 0 && dist < worstCase * GRID_DEFAULTS.liquidationBufferRatio * 0.35){
        tradingBotLog(bot, `Liquidation risk — a ${leg.direction} leg's est. liquidation (${liqPrice.toFixed(6)}) is too close to mark (${snap.price.toFixed(6)}) — flattening the whole bot.`, true);
        const flat = await flattenGridBot(bot, proxyArgs, 'GRID_FLATTEN_LIQ_RISK');
        if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
        else logGridFlattenResult(bot, flat);
        bot.status = 'closed'; bot.stoppedAtMs = Date.now();
        renderTradingBotsList();
        return;
      }
    }

    const openOrdersResp = await callProxy('/api/futures/grid/orders', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!openOrdersResp.ok){ tradingBotLog(bot, `Could not read open orders: ${openOrdersResp.message}`, true); return; }
    const openIds = new Set(openOrdersResp.list.map(o => String(o.orderId)));

    // Real floating P&L on whatever's currently open — separate from
    // bot.realizedUsd (closed cycles only). Read fresh every cycle so the
    // card always reflects the exchange's own mark, not a stale snapshot.
    const posResp = await callProxy('/api/futures/grid/positions', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    bot.runtime.unrealizedUsd = posResp.ok ? (posResp.long?.unrealisedPnl || 0) + (posResp.short?.unrealisedPnl || 0) : null;

    await applyGridRecovery(bot, plan, snap, proxyArgs);
    if(bot.status !== 'active') return; // recovery itself never closes the bot, but stays consistent with every other early-return in this tick

    // ---- Close-order-vanished handling (fix) ------------------------------
    // A resting TP close order disappearing from the open-orders list does
    // NOT prove it filled: when the side's protective stop fires, Bybit
    // cancels every reduce-only TP on that side too. The old code treated
    // both cases as "TP hit" and booked a modeled +profit while the exchange
    // had really booked a loss. Now every vanished close order is settled
    // against Bybit's own closed-P&L rows: a row with this order's id = real
    // TP; unclaimed close rows on that side = stop-out (booked as-is).
    bot.runtime.claimedPnl = bot.runtime.claimedPnl || [];
    const claimed = new Set(bot.runtime.claimedPnl.map(String));
    let pnlRowsCache = null;
    const getPnlRows = async () => {
      if(pnlRowsCache !== null) return pnlRowsCache;
      if(bot.exchange !== 'bybit'){ pnlRowsCache = []; return pnlRowsCache; }
      const r = await callProxy('/api/futures/grid/closed-pnl', proxyArgs).catch(() => null);
      pnlRowsCache = r && r.ok ? (r.list || []) : [];
      return pnlRowsCache;
    };
    const claimRow = (orderId) => { claimed.add(String(orderId)); bot.runtime.claimedPnl.push(String(orderId)); if(bot.runtime.claimedPnl.length > 400) bot.runtime.claimedPnl.splice(0, 100); };
    // Real exchange fill times (orderId -> ms), fetched at most once per cycle. This manager only runs
    // while the page is open, so "when we noticed the fill" can be hours after the fill itself; using
    // the exchange's own timestamps is what makes Duration = entry-fill -> close-fill. If the server
    // hasn't been updated (or the call fails) this is just an empty map and we fall back to nowMs.
    let fillTimesCache = null;
    const getFillTimes = async () => {
      if(fillTimesCache !== null) return fillTimesCache;
      fillTimesCache = new Map();
      const r = await callProxy('/api/futures/grid/fill-times', proxyArgs).catch(() => null);
      if(r && r.ok) for(const o of (r.list || [])) fillTimesCache.set(String(o.orderId), o.filledAtMs);
      return fillTimesCache;
    };

    for(const level of bot.runtime.levels){
      if(level.status === 'PENDING_ENTRY' && level.entryOrderId != null && !openIds.has(String(level.entryOrderId))){
        const targetPrice = plan.levels[level.targetIndex];
        if(targetPrice == null){ level.status = 'FILLED_NO_TARGET'; continue; }
        const perLevelUsd = plan.allocationUsd / plan.levelCount;
        const qty = (perLevelUsd * plan.leverage) / level.price;
        const closed = await callProxy('/api/futures/grid/place-close', { ...proxyArgs, direction: level.direction, price: targetPrice, qty, orderLinkTag: `${bot.id}-${level.levelIndex}` }).catch(err => ({ ok:false, message: err.message }));
        if(!closed.ok){ tradingBotLog(bot, `Level ${level.levelIndex} filled but its close order failed: ${closed.message}`, true); continue; }
        level.status = 'PENDING_CLOSE'; level.closeOrderId = closed.orderId; level.entryPrice = level.price; level.targetPrice = targetPrice;
        level.openedAt = (await getFillTimes()).get(String(level.entryOrderId)) || nowMs; // exchange fill time, not detection time
        const stopField = level.direction === 'LONG' ? 'longStopSet' : 'shortStopSet';
        if(!bot.runtime[stopField]){
          const stopPrice = level.direction === 'LONG' ? plan.lower : plan.upper;
          const stopResult = await callProxy('/api/futures/grid/set-side-stop', { ...proxyArgs, direction: level.direction, stopPrice }).catch(err => ({ ok:false, message: err.message }));
          if(stopResult.ok) bot.runtime[stopField] = true;
          else tradingBotLog(bot, `Could not attach protective stop on the ${level.direction} side: ${stopResult.message} — that side has NO exchange-side protection yet.`, true);
        }
      } else if(level.status === 'PENDING_CLOSE' && level.closeOrderId != null && !openIds.has(String(level.closeOrderId))){
        const perLevelUsd = plan.allocationUsd / plan.levelCount;
        const qty = (perLevelUsd * plan.leverage) / level.entryPrice;
        const dirKey = level.direction === 'LONG' ? 'long' : 'short';
        const closingSide = level.direction === 'LONG' ? 'Sell' : 'Buy';
        const sidePos = posResp.ok ? posResp[dirKey] : null;
        const rows = await getPnlRows();
        const tpRow = rows.find(r => String(r.orderId) === String(level.closeOrderId));

        // Sibling legs on this side whose TP is still resting — their qty is still legitimately held.
        const siblings = bot.runtime.levels.filter(l => l !== level && l.direction === level.direction && l.status === 'PENDING_CLOSE' && l.closeOrderId != null && openIds.has(String(l.closeOrderId)));
        const siblingQty = siblings.reduce((a, l) => a + (plan.allocationUsd / plan.levelCount * plan.leverage) / l.entryPrice, 0);

        if(!tpRow && posResp.ok && sidePos && sidePos.size >= siblingQty + qty * 0.9){
          // Position still holds this leg's size -> the TP was cancelled (not filled). Re-place it.
          const again = await callProxy('/api/futures/grid/place-close', { ...proxyArgs, direction: level.direction, price: level.targetPrice, qty, orderLinkTag: `${bot.id}-${level.levelIndex}-c${nowMs % 100000}` }).catch(err => ({ ok:false, message: err.message }));
          if(again.ok){ level.closeOrderId = again.orderId; tradingBotLog(bot, `Level ${level.levelIndex}'s take-profit order was cancelled while the position is still open — re-placed it.`, true); }
          else tradingBotLog(bot, `Level ${level.levelIndex}'s take-profit order vanished with the position still open and re-placing failed: ${again.message}`, true);
          continue;
        }

        if(tpRow){
          // ---- genuine take-profit fill, exchange-verified ----
          const estimate = netCycleProfit({ entryPrice: level.entryPrice, exitPrice: level.targetPrice, qty, direction: level.direction, exchange: bot.exchange, holdMinutes: (nowMs - level.openedAt) / 60_000, fundingRatePct: snap.meta.fundingRatePct, slippagePct: snap.meta.spreadPct });
          const pnl = await resolveGridCyclePnl(proxyArgs, level.closeOrderId, estimate);
          claimRow(level.closeOrderId);
          tradingBotLog(bot, `Level ${level.levelIndex} cycle closed — ${fmtUsd(pnl.netUsd)} (${pnl.pnlSource === 'exchange' ? 'Bybit-verified' : 'estimated'}).`, false);
          const closedAt = pnl.closedAtMs || (await getFillTimes()).get(String(level.closeOrderId)) || nowMs;
          // Entry/exit/qty come from the SAME Bybit row as the P&L so a row's prices always reproduce its P&L
          // (Bybit realizes hedge-mode closes against the position's AVERAGE entry, not this level's own price).
          bookBotTrade(bot, {
            closedAtMs: closedAt, openedAtMs: level.openedAt, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: level.direction, direction: level.direction,
            entry: pnl.avgEntryPrice || level.entryPrice, exit: pnl.avgExitPrice || level.targetPrice, qty: pnl.qty || qty, leverage: plan.leverage,
            grossUsd: pnl.grossUsd != null ? pnl.grossUsd : estimate.grossUsd, feesUsd: pnl.feesUsd != null ? pnl.feesUsd : estimate.feesUsd,
            fundingUsd: pnl.fundingUsd != null ? pnl.fundingUsd : estimate.fundingUsd, slippageUsd: pnl.slippageUsd != null ? pnl.slippageUsd : estimate.slippageUsd,
            netUsd: pnl.netUsd, pnlSource: pnl.pnlSource, feesReal: pnl.pnlSource === 'exchange' && pnl.feesUsd != null,
            confidence: null, setupType: 'Trading Bot: Grid', exitReason: 'GRID_CYCLE_TP', durationMin: Math.max(0, Math.round((closedAt - level.openedAt) / 60_000)), durationSec: Math.max(0, Math.round((closedAt - level.openedAt) / 1000)),
            gridId: bot.id, gridLevel: level.levelIndex, entryOrderId: level.entryOrderId, closeOrderId: level.closeOrderId, cycleResult: pnl.netUsd > 0 ? 'WIN' : 'LOSS',
          });
          level.missTicks = 0;
          const rePlaced = await callProxy('/api/futures/grid/place-level', { ...proxyArgs, direction: level.direction, price: level.price, qty, leverage: plan.leverage, orderLinkTag: `${bot.id}-${level.levelIndex}-r`, stopLoss: level.direction === 'LONG' ? plan.lower : plan.upper }).catch(err => ({ ok:false, message: err.message }));
          if(rePlaced.ok){ level.status = 'PENDING_ENTRY'; level.entryOrderId = rePlaced.orderId; level.closeOrderId = null; }
          else { level.status = 'IDLE'; level.entryOrderId = null; level.closeOrderId = null; tradingBotLog(bot, `Cycle closed on level ${level.levelIndex} but couldn't re-arm it: ${rePlaced.message}`, true); }
          continue;
        }

        // ---- No TP row for this order: side stop-out, or Bybit hasn't indexed the fill yet ----
        const trackedIds = new Set(bot.runtime.levels.map(l => l.closeOrderId).filter(x => x != null).map(String));
        const sideStart = Math.min(...bot.runtime.levels.filter(l => l.direction === level.direction && l.openedAt).map(l => l.openedAt), level.openedAt) - 120_000;
        const stopRows = rows.filter(r => r.side === closingSide && r.createdTime >= sideStart && !claimed.has(String(r.orderId)) && !trackedIds.has(String(r.orderId)));

        if(stopRows.length){
          let total = 0;
          for(const r of stopRows){
            claimRow(r.orderId);
            total += r.closedPnl;
            bookBotTrade(bot, {
              closedAtMs: r.createdTime || nowMs, openedAtMs: level.openedAt, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: level.direction, direction: level.direction,
              entry: r.avgEntryPrice, exit: r.avgExitPrice, qty: r.qty, leverage: plan.leverage,
              grossUsd: r.feesUsd != null ? r.closedPnl + Math.abs(r.feesUsd) : null, feesUsd: r.feesUsd != null ? Math.abs(r.feesUsd) : null, feesReal: r.feesUsd != null, fundingUsd: null, slippageUsd: null, netUsd: r.closedPnl, pnlSource: 'exchange',
              confidence: null, setupType: 'Trading Bot: Grid', exitReason: 'GRID_SIDE_STOP', durationMin: Math.max(0, Math.round(((r.createdTime || nowMs) - level.openedAt) / 60_000)),
              gridId: bot.id, gridLevel: level.levelIndex, entryOrderId: level.entryOrderId, closeOrderId: r.orderId, cycleResult: r.closedPnl > 0 ? 'WIN' : 'LOSS',
            });
          }
          // Every leg on this side whose TP vanished was closed by that same stop.
          for(const l of bot.runtime.levels){
            if(l.direction === level.direction && l.status === 'PENDING_CLOSE' && l.closeOrderId != null && !openIds.has(String(l.closeOrderId))){
              l.status = 'IDLE'; l.entryOrderId = null; l.closeOrderId = null; l.missTicks = 0;
            }
          }
          bot.runtime[level.direction === 'LONG' ? 'longStopSet' : 'shortStopSet'] = false;
          tradingBotLog(bot, `${level.direction} side STOPPED OUT on the exchange — ${stopRows.length} close(s) booked from Bybit, ${fmtUsd(total)} net. Affected levels will re-arm when price is back inside the range.`, true);
          continue;
        }

        // Nothing indexed yet: wait a few ticks before ever falling back to an estimate.
        level.missTicks = (level.missTicks || 0) + 1;
        const waitTicks = bot.exchange === 'bybit' ? 4 : 0;
        if(level.missTicks <= waitTicks){ continue; }
        if(level.closeOrderId != null) claimRow(level.closeOrderId); // booked below as an estimate — the exchange row for this order must never be booked a second time
        const stopPx = level.direction === 'LONG' ? plan.lower : plan.upper;
        const stoppedOut = level.direction === 'LONG' ? snap.price <= stopPx : snap.price >= stopPx;
        const exitPx = stoppedOut ? stopPx : level.targetPrice;
        const estimate = netCycleProfit({ entryPrice: level.entryPrice, exitPrice: exitPx, qty, direction: level.direction, exchange: bot.exchange, holdMinutes: (nowMs - level.openedAt) / 60_000, fundingRatePct: snap.meta.fundingRatePct, slippagePct: snap.meta.spreadPct });
        tradingBotLog(bot, `Level ${level.levelIndex} closed — ${fmtUsd(estimate.netUsd)} (estimated ${stoppedOut ? 'as a stop-out' : 'as a take-profit'}; exchange P&L not available). Use Verify with Bybit to reconcile.`, true);
        bookBotTrade(bot, {
          closedAtMs: nowMs, openedAtMs: level.openedAt, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: level.direction, direction: level.direction,
          entry: level.entryPrice, exit: exitPx, qty, leverage: plan.leverage,
          grossUsd: estimate.grossUsd, feesUsd: estimate.feesUsd, fundingUsd: estimate.fundingUsd, slippageUsd: estimate.slippageUsd, netUsd: estimate.netUsd, pnlSource: 'estimate',
          confidence: null, setupType: 'Trading Bot: Grid', exitReason: stoppedOut ? 'GRID_SIDE_STOP' : 'GRID_CYCLE_TP', durationMin: Math.round((nowMs - level.openedAt) / 60_000),
          gridId: bot.id, gridLevel: level.levelIndex, entryOrderId: level.entryOrderId, closeOrderId: level.closeOrderId, cycleResult: estimate.netUsd > 0 ? 'WIN' : 'LOSS',
        });
        level.missTicks = 0;
        level.status = 'IDLE'; level.entryOrderId = null; level.closeOrderId = null;
      } else if(level.status === 'IDLE' && level.price != null){
        // Re-arm a level that was stopped out (or failed to re-arm) once price is back on the correct side of it.
        const buffer = snap.price * 0.0005;
        const okSide = level.direction === 'LONG' ? level.price < snap.price - buffer : level.price > snap.price + buffer;
        const inRange = snap.price > plan.lower && snap.price < plan.upper;
        if(okSide && inRange){
          const perLevelUsd = plan.allocationUsd / plan.levelCount;
          const qty = (perLevelUsd * plan.leverage) / level.price;
          const rePlaced = await callProxy('/api/futures/grid/place-level', { ...proxyArgs, direction: level.direction, price: level.price, qty, leverage: plan.leverage, orderLinkTag: `${bot.id}-${level.levelIndex}-a${nowMs % 100000}`, stopLoss: level.direction === 'LONG' ? plan.lower : plan.upper }).catch(err => ({ ok:false, message: err.message }));
          if(rePlaced.ok){ level.status = 'PENDING_ENTRY'; level.entryOrderId = rePlaced.orderId; tradingBotLog(bot, `Level ${level.levelIndex} re-armed.`, false); }
        }
      }
    }
    // This bot's OWN Max Loss / Profit Target — separate from, and checked
    // before, the cross-bot daily cap: this can flatten just THIS bot while
    // others keep running, unlike the daily cap which stops everything.
    if(bot.status === 'active'){
      const maxLossPct = bot.config?.maxLossPct;
      const profitTargetPct = bot.config?.profitTargetPct;
      const lossFloorUsd = maxLossPct ? -bot.investmentUsd * (maxLossPct / 100) : null;
      const profitCeilUsd = profitTargetPct ? bot.investmentUsd * (profitTargetPct / 100) : null;
      // Profit Target counts closed profit PLUS the floating P&L of open legs (same figure as Total P/L and the progress bar).
      // Max Loss uses the same total (realized + floating): a bot sitting on a big open loss has to be stopped at its limit,
      // not only after the loss has been realized by an exchange-side stop.
      const targetPnlUsd = bot.realizedUsd + (Number.isFinite(bot.runtime?.unrealizedUsd) ? bot.runtime.unrealizedUsd : 0);
      if(lossFloorUsd != null && targetPnlUsd <= lossFloorUsd){
        tradingBotLog(bot, `This bot's Max Loss (${maxLossPct}%) reached — flattening.`, true);
        const flat = await flattenGridBot(bot, proxyArgs, 'GRID_FLATTEN_MAX_LOSS');
        if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
        else logGridFlattenResult(bot, flat);
        bot.status = 'closed'; bot.stoppedAtMs = Date.now();
      } else if(profitCeilUsd != null && targetPnlUsd >= profitCeilUsd){
        tradingBotLog(bot, `This bot's Profit Target (${profitTargetPct}%) reached (${fmtUsd(targetPnlUsd)} incl. floating) — flattening.`, false);
        const flat = await flattenGridBot(bot, proxyArgs, 'GRID_FLATTEN_TARGET');
        if(!flat.ok) tradingBotLog(bot, `Flatten call failed: ${flat.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
        else logGridFlattenResult(bot, flat);
        bot.status = 'closed'; bot.stoppedAtMs = Date.now();
      }
    }
    if(bot.status === 'active'){
      tradingBotLog(bot, `Running — ${bot.runtime.levels.filter(l => l.status === 'PENDING_CLOSE').length} leg(s) open, ${fmtUsd(bot.realizedUsd)} realized, ${bot.runtime.unrealizedUsd != null ? fmtUsd(bot.runtime.unrealizedUsd) + ' unrealized' : 'unrealized unknown'}.`, false);
    }
  }

  // -------------------------------------------------------------
  // DCA bot — deployment + ongoing management. One-way mode; safety
  // orders just accumulate into the same position, average price shifts,
  // TP is re-set to the new average after every fill. Closure (TP or the
  // optional hard stop firing) is detected by the position going flat —
  // see the header note in dca.js for why that's the reliable signal
  // rather than watching for a specific order to disappear.
  // -------------------------------------------------------------
  async function deployDcaBotInstance(bot, cred){
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    const snap = await fetchSnapshot(bot.exchange, bot.symbol, '5m').catch(err => { bot.status = 'error'; tradingBotLog(bot, `Snapshot fetch failed: ${err.message}`, true); return null; });
    if(!snap) return;
    const plan = buildDcaPlan({ symbol: bot.symbol, direction: bot.direction, anchorPrice: snap.price, cfg: bot.config });
    if(!plan){ bot.status = 'error'; tradingBotLog(bot, 'Could not build a valid DCA plan from these settings.', true); return; }
    bot.plan = plan; bot.investmentUsd = plan.totalInvestmentUsd;
    fu().tbDayAnchorInvestmentUsd += bot.investmentUsd;
     // refresh the daily-limits header now that the anchor total changed

    const balResp = await callProxy('/api/futures/balance', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    bot.runtime.balanceBeforeUsd = balResp.ok ? balResp.balance : null;
    bot.runtime.openedAtMs = Date.now();

    const baseQty = (plan.baseOrderUsd * plan.leverage) / snap.price;
    const baseResult = await callProxy('/api/futures/dca/place', { ...proxyArgs, direction: bot.direction, orderType: 'MARKET', qty: baseQty, leverage: plan.leverage, botTag: bot.id, role: 'base' }).catch(err => ({ ok:false, message: err.message }));
    if(!baseResult.ok){ bot.status = 'error'; tradingBotLog(bot, `Base order failed: ${baseResult.message}`, true); return; }

    bot.runtime.safetyOrders = [];
    for(const level of plan.safetyLevels){
      const qty = (level.sizeUsd * plan.leverage) / level.price;
      const placed = await callProxy('/api/futures/dca/place', { ...proxyArgs, direction: bot.direction, orderType: 'LIMIT', price: level.price, qty, leverage: plan.leverage, botTag: bot.id, role: 'so' }).catch(err => ({ ok:false, message: err.message }));
      if(!placed.ok){ tradingBotLog(bot, `Safety order ${level.index} skipped: ${placed.message}`, false); continue; }
      bot.runtime.safetyOrders.push({ index: level.index, orderId: placed.orderId, price: level.price, status: 'PENDING' });
    }

    // Confirm the base order's real fill and set the initial TP off it —
    // a market order should be filled by the time we get here, but poll
    // briefly rather than assume.
    const posResp = await callProxy('/api/futures/position', { ...proxyArgs, openedAtMs: bot.runtime.openedAtMs, balanceBeforeUsd: bot.runtime.balanceBeforeUsd }).catch(err => ({ ok:false, message: err.message }));
    if(posResp.ok && posResp.open){
      bot.runtime.avgEntryPrice = posResp.position.avgPrice; bot.runtime.totalQty = posResp.position.size;
      const exits = computeDcaExitPrices({ direction: bot.direction, avgEntryPrice: bot.runtime.avgEntryPrice, takeProfitPct: plan.takeProfitPct, stopLossPct: plan.stopLossPct });
      const tpResult = await callProxy('/api/futures/dca/set-tp', { ...proxyArgs, direction: bot.direction, takeProfitPrice: exits.takeProfitPrice, stopLossPrice: exits.stopLossPrice, existingTpAlgoId: bot.runtime.tpAlgoId, existingSlAlgoId: bot.runtime.slAlgoId }).catch(err => ({ ok:false, message: err.message }));
      if(tpResult.ok){ bot.runtime.tpAlgoId = tpResult.tpAlgoId || null; bot.runtime.slAlgoId = tpResult.slAlgoId || null; }
      else tradingBotLog(bot, `Base order filled but setting take-profit failed: ${tpResult.message} — the position is OPEN WITHOUT a take-profit yet, will retry next cycle.`, true);
    } else {
      tradingBotLog(bot, `Base order sent but position isn't confirmed open yet — will confirm and set take-profit next cycle.`, false);
    }
    bot.status = 'active';
    tradingBotLog(bot, `DCA ACTIVE — base order sent, ${bot.runtime.safetyOrders.length}/${plan.safetyLevels.length} safety orders resting.`, false);
  }

  async function manageDcaBotInstance(bot, cred, nowMs){
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    const posResp = await callProxy('/api/futures/position', { ...proxyArgs, openedAtMs: bot.runtime.openedAtMs, balanceBeforeUsd: bot.runtime.balanceBeforeUsd }).catch(err => ({ ok:false, message: err.message }));
    if(!posResp.ok){ tradingBotLog(bot, `Could not read position: ${posResp.message}`, true); return; }

    bot.runtime.unrealizedUsd = posResp.open ? posResp.position.unrealisedPnl : null;

    if(!posResp.open){
      // Flat — TP or the hard stop fired (or it was closed manually on the
      // exchange). Cancel anything still resting, log what we can from the
      // exchange's own realized-PnL read (real, not estimated — same
      // balance-diff/closed-pnl mechanism the six strategies' Live/Demo
      // trades already use), and mark this bot done.
      await callProxy('/api/futures/dca/flatten', proxyArgs).catch(() => {});
      const closed = posResp.closed;
      const record = {
        closedAtMs: nowMs, exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: bot.direction,
        entry: closed && closed.avgEntryPrice != null ? closed.avgEntryPrice : bot.runtime.avgEntryPrice,
        exit: closed && closed.avgExitPrice != null ? closed.avgExitPrice : null,
        leverage: bot.plan.leverage, qty: bot.runtime.totalQty,
        grossUsd: closed && closed.grossPnl != null ? closed.grossPnl : null,
        feesUsd: closed && closed.feesUsd != null ? Math.abs(closed.feesUsd) : null,
        netUsd: closed ? closed.closedPnl : 0, pnlSource: closed && closed.pnlSource ? closed.pnlSource : null,
        setupType: 'Trading Bot: DCA', durationMin: Math.round((nowMs - bot.runtime.openedAtMs) / 60_000), gridId: bot.id,
      };
      if(appendPersistentTrade(record)){
        bot.realizedUsd = record.netUsd || 0;
        addTradingBotsRealized(bot.realizedUsd);
      } // else: a Stop / daily-limit flatten already booked this same close — don't count it twice
      bot.status = 'closed'; bot.stoppedAtMs = Date.now();
      tradingBotLog(bot, `Position closed — ${fmtUsd(bot.realizedUsd)} realized.`, false);
      return;
    }

    if(posResp.position.size > (bot.runtime.totalQty || 0) + 1e-9){
      // A safety order filled — average moved, re-set TP.
      bot.runtime.avgEntryPrice = posResp.position.avgPrice; bot.runtime.totalQty = posResp.position.size;
      const filledOrder = bot.runtime.safetyOrders.find(s => s.status === 'PENDING'); // best-effort marker; exact matching would need an open-orders diff like Grid's, kept simple since TP re-set is what actually matters here
      const orders = await callProxy('/api/futures/dca/orders', proxyArgs).catch(() => ({ ok:false }));
      if(orders.ok){
        const openIds = new Set(orders.list.map(o => String(o.orderId)));
        for(const s of bot.runtime.safetyOrders){ if(s.status === 'PENDING' && !openIds.has(String(s.orderId))) s.status = 'FILLED'; }
      } else if(filledOrder){
        filledOrder.status = 'FILLED';
      }
      const exits = computeDcaExitPrices({ direction: bot.direction, avgEntryPrice: bot.runtime.avgEntryPrice, takeProfitPct: bot.plan.takeProfitPct, stopLossPct: bot.plan.stopLossPct });
      const tpResult = await callProxy('/api/futures/dca/set-tp', { ...proxyArgs, direction: bot.direction, takeProfitPrice: exits.takeProfitPrice, stopLossPrice: exits.stopLossPrice, existingTpAlgoId: bot.runtime.tpAlgoId, existingSlAlgoId: bot.runtime.slAlgoId }).catch(err => ({ ok:false, message: err.message }));
      if(tpResult.ok){ bot.runtime.tpAlgoId = tpResult.tpAlgoId || null; bot.runtime.slAlgoId = tpResult.slAlgoId || null; }
      else tradingBotLog(bot, `Safety order filled but re-setting take-profit failed: ${tpResult.message} — retrying next cycle.`, true);
      tradingBotLog(bot, `Safety order filled — average now ${bot.runtime.avgEntryPrice.toFixed(6)}, TP re-set to ${exits.takeProfitPrice.toFixed(6)}.`, false);
    } else {
      tradingBotLog(bot, `Running — avg ${bot.runtime.avgEntryPrice.toFixed(6)}, size ${bot.runtime.totalQty}, uPnL ${fmtUsd(posResp.position.unrealisedPnl)}.`, false);
    }
  }

  // -------------------------------------------------------------
  // Cross-bot daily profit/loss cap — see the tbDay* fields' comment in
  // state.js. Rolls over at UTC midnight, same day-key convention as
  // NxTGen Grid's own rollGridLiveDay.
  // -------------------------------------------------------------
  function rollTradingBotsDay(nowMs){
    const f = fu();
    const key = Math.floor(nowMs / 86_400_000);
    if(f.tbDayKey === key) return;
    f.tbDayKey = key;
    f.tbDayAnchorInvestmentUsd = 0;
    f.tbDayRealizedUsd = 0;
    f.tbDailyHalted = false;
    f.tbDailyHaltMessage = null;
    f.tbDailyHaltKind = null;
  }

  function addTradingBotsRealized(deltaUsd){
    const f = fu();
    f.tbDayRealizedUsd += deltaUsd;
    // Checked on the next tick, not inline: the booking code that called us is still mid-way (trade row, bot
    // status). A halt started right here would flatten that same bot and book its close a second time.
    setTimeout(checkTradingBotsDailyLimits, 0);
  }

  function checkTradingBotsDailyLimits(){
    const f = fu();
    if(f.tbDailyHalted || !(f.tbDayAnchorInvestmentUsd > 0)) return;
    const pct = (f.tbDayRealizedUsd / f.tbDayAnchorInvestmentUsd) * 100;
    if(pct >= f.tbDailyProfitTargetPct){
      // Profit target: stop opening NEW bots/grids for the rest of the day,
      // but don't force-close bots that are already running — they keep
      // going and exit on their own TP/SL/grid logic, same as NxTGen
      // Grid's own single-deployment daily-target behavior (line ~503-509).
      haltTradingBotsForToday(`Daily profit target (${f.tbDailyProfitTargetPct}%) reached — ${pct.toFixed(1)}% realized today across all bots. No new bots/grids until tomorrow — bots already running are left alone.`, { flattenActive: false });
    } else if(f.tbDailyMaxLossPct && pct <= -f.tbDailyMaxLossPct){
      // Max loss: this IS a safety cutoff, so it still force-flattens
      // everything immediately, unchanged from before.
      haltTradingBotsForToday(`Daily max loss (${f.tbDailyMaxLossPct}%) reached — ${pct.toFixed(1)}% realized today across all bots.`, { flattenActive: true });
    }
  }

  // Blocks new bot/auto-scan creation for the rest of the day via
  // tbDailyHalted (checked by runGridAutoScan and createTradingBotFromForm)
  // until the next rollTradingBotsDay resets it. flattenActive controls
  // whether bots already running get force-stopped right now:
  //  - profit target reached -> flattenActive:false — already-open bots
  //    (including auto-scan grids) are left running and close naturally;
  //    runGridAutoScan's maxConcurrent slot frees up when they do, but new
  //    scanning stays paused since tbDailyHalted is still true today.
  //  - max loss reached -> flattenActive:true — force-stops EVERY active
  //    bot immediately (the exact same flatten/stop path the Stop button
  //    uses), since this is a hard risk cutoff, not just a "stop looking
  //    for more" signal.
  async function haltTradingBotsForToday(reason, { flattenActive = true } = {}){
    const f = fu();
    if(f.tbDailyHalted) return; // already in progress/done — avoid double-flattening if this fires twice in the same tick
    f.tbDailyHalted = true;
    f.tbDailyHaltMessage = reason;
    f.tbDailyHaltKind = flattenActive ? 'loss' : 'profit';
    if(flattenActive){
      const activeBots = f.tradingBots.filter(b => b.status === 'active');
      for(const bot of activeBots){
        await stopTradingBot(bot.id).catch(() => {});
      }
    }
    renderTradingBotsList();
  
  }

  // Reads the real, current exchange available balance and checks whether
  // there's room for a bot that wants to commit ~neededUsd of margin.
  // Used before every grid deployment (auto-scan and manual) so a bot's
  // configured size is never just blindly trusted against the account —
  // resting grid limit orders reserve exchange margin the moment they're
  // placed, even before anything fills, so "the config says $X" isn't
  // enough on its own to know $X is actually free right now.
  async function checkAvailableMarginFor(proxyArgs, neededUsd){
    // /api/futures/available-margin, not /api/futures/balance: the latter is
    // Bybit's total wallet balance, which stays the same even once other
    // running bots have locked most of it up as margin — checking against it
    // kept saying "enough margin" right up until real order placement failed
    // on the exchange. This checks actual free/available margin instead, so
    // it accurately blocks a new deployment before it's created (rather than
    // creating it and having it fail with grid levels rejected one by one).
    const balResp = await callProxy('/api/futures/available-margin', proxyArgs).catch(err => ({ ok:false, message: err.message }));
    if(!balResp.ok || balResp.available == null) return { ok:false, available:null };
    return { ok: balResp.available >= neededUsd, available: balResp.available };
  }

  // Actually closes whatever this bot currently has open — shared by
  // Stop and (for Smart Bots) Pause; the only difference between those
  // two is what happens to the bot record AFTERWARD (Stop ends it for
  // good, Pause puts it to sleep so Resume can redeploy it fresh). Grid
  // runs in hedge mode with no server-side "closed P&L" detector the way
  // DCA's single-sided position has, so its number here is the last
  // polled floating P&L read immediately before the flatten call — an
  // ESTIMATE, not a post-close balance-diff — and is logged/tagged as
  // such (exitReason ends in "_EST"). DCA's number comes from the exact
  // same balance-diff/closed-PnL read its own normal TP/SL close
  // detection already uses, so it's exact.
  async function closeBotPositionForcefully(bot, cred, reasonLabel){
    const proxyArgs = { exchange: bot.exchange, mode: bot.mode, apiKey: cred.apiKey, secretKey: cred.secretKey, passphrase: cred.passphrase, symbol: bot.symbol };
    let netUsd = 0, hadSomethingOpen = false, entry = null, exit = null, qty = null;

    if(bot.type === 'grid'){
      // Books the real closing trade(s) itself (see flattenGridBot), so nothing more to add below.
      const res = await flattenGridBot(bot, proxyArgs, `GRID_${reasonLabel}`);
      if(!res.ok) return { ok:false, message: res.message };
      return { ok:true, netUsd: res.total, hadSomethingOpen: res.hadOpen };
    } else {
      const flat = await callProxy('/api/futures/dca/flatten', proxyArgs).catch(err => ({ ok:false, message: err.message }));
      if(!flat.ok) return { ok:false, message: flat.message };
      const posResp = await callProxy('/api/futures/position', { ...proxyArgs, openedAtMs: bot.runtime.openedAtMs, balanceBeforeUsd: bot.runtime.balanceBeforeUsd }).catch(() => ({ ok:false }));
      if(posResp.ok && posResp.closed){
        hadSomethingOpen = true;
        netUsd = posResp.closed.closedPnl || 0;
        entry = posResp.closed.avgEntryPrice != null ? posResp.closed.avgEntryPrice : bot.runtime.avgEntryPrice;
        exit = posResp.closed.avgExitPrice != null ? posResp.closed.avgExitPrice : null;
        qty = bot.runtime.totalQty || null;
      } else if(bot.runtime.totalQty > 0){
        hadSomethingOpen = true; // couldn't confirm the exact closed number, but there was definitely something open
      }
    }

    if(hadSomethingOpen){
      bookBotTrade(bot, {
        closedAtMs: Date.now(), exchange: bot.exchange, mode: bot.mode, symbol: bot.symbol, side: bot.direction,
        entry, exit, leverage: bot.leverage || bot.plan?.leverage || null, qty, netUsd,
        setupType: `Trading Bot: ${bot.type === 'grid' ? 'Grid' : 'DCA'} (${reasonLabel === 'PAUSED' ? 'paused' : 'stopped'})`,
        durationMin: bot.runtime.openedAtMs ? Math.round((Date.now() - bot.runtime.openedAtMs) / 60_000) : null,
        gridId: bot.id, exitReason: bot.type === 'grid' ? `${reasonLabel}_EST` : reasonLabel,
      });
    }
    return { ok:true, netUsd, hadSomethingOpen };
  }

  // ---------------- server-side lifecycle ----------------

  // A cheap fingerprint of everything a restart must NOT forget: which orders a bot has resting, its status, what it has
  // realized, how many trades are booked. When it changes during a cycle the store is written right away instead of on the
  // normal (slower) schedule — so a crash/restart between two saves can't leave orders on the exchange the bot doesn't know about.
  function structSig(){
    return JSON.stringify([S.trades.length, S.tradingBots.map(b => {
      const r = b.runtime || {};
      return [b.id, b.status, !!b.paused, b.realizedUsd, (r.levels || []).map(l => [l.status, l.entryOrderId, l.closeOrderId]), r.tpAlgoId, r.slAlgoId, r.totalQty, r.safetyOrders];
    })]);
  }
  const saveSoon = () => { Promise.resolve(store.flushNow()).catch(() => {}); };

  // Stop = flatten everything this bot has on the exchange, then mark it stopped. Same as the Stop button.
  // One stop at a time per bot, and never on a bot that is already stopped (Stop button + daily-limit halt +
  // the cycle can all reach here for the same bot within seconds).
  const stoppingBotIds = new Set();
  async function stopTradingBot(id){
    const bot = S.tradingBots.find(b => b.id === id);
    if(!bot || bot.status === 'closed' || stoppingBotIds.has(id)) return;
    stoppingBotIds.add(id);
    try{ return await stopTradingBotNow(id); }
    finally{ stoppingBotIds.delete(id); }
  }
  async function stopTradingBotNow(id){
    const bot = S.tradingBots.find(b => b.id === id);
    if(!bot) return;
    const cred = liveCred(bot.exchange, bot.mode);
    if(cred){
      const result = await closeBotPositionForcefully(bot, cred, 'STOPPED');
      if(!result.ok) tradingBotLog(bot, `Stop/flatten failed: ${result.message} — check ${bot.symbol} on ${bot.exchange} directly.`, true);
      else tradingBotLog(bot, result.hadSomethingOpen ? `Stopped — every pending order cancelled, open position closed at ${fmtUsd(result.netUsd)} realized (regardless of win/loss).` : 'Stopped — pending orders cancelled, nothing was open.', false);
    } else {
      tradingBotLog(bot, `Stopped — but the server has no saved ${bot.exchange} ${bot.mode} key, so it could NOT cancel orders or close anything. Check ${bot.symbol} on ${bot.exchange} directly.`, true);
    }
    bot.status = 'closed'; bot.stoppedAtMs = Date.now();   // 'closed' is the one "stopped" status every screen counts (this used to say 'stopped', so the account page never counted manually-stopped bots)
    await store.flushNow();
  }

  async function runCycle(){
    if(cycleBusy) return;
    cycleBusy = true;
    try{
      rollTradingBotsDay(Date.now());
      const active = S.tradingBots.filter(b => b.status === 'active' && !b.paused);
      const start = Date.now();
      for(const bot of active){
        bot.runtime = bot.runtime || {};
        const last = bot.runtime.lastTickAtMs;
        if(last && start - last > GAP_NOTICE_MS) bot.runtime.gapNotice = { ms: start - last, atMs: start };
        bot.runtime.lastTickAtMs = start;
      }
      const before = structSig();
      for(const bot of active){
        const cred = liveCred(bot.exchange, bot.mode);
        if(!cred){ tradingBotLog(bot, `The server has no saved ${bot.exchange} ${bot.mode} key — re-sync your API keys from the browser.`, true); continue; }
        try{
          if(bot.type === 'grid') await manageGridBotInstance(bot, cred, Date.now());
          else await manageDcaBotInstance(bot, cred, Date.now());
        }catch(err){
          tradingBotLog(bot, `Unexpected error managing this bot: ${err.message}`, true);
        }
      }
      if(structSig() !== before) await store.flushNow();
      else store.touch();
    } finally { cycleBusy = false; }
  }

  function num(v){ return typeof v === 'number' && Number.isFinite(v); }

  // Accepts a bot the browser just built (status 'deploying') and takes over: places its orders and then manages it.
  function handoff(input, limits){
    const b = input || {};
    if(!/^[A-Za-z0-9_-]{6,64}$/.test(String(b.id || ''))) throw httpErr(400, 'Bad bot id.');
    if(S.tradingBots.some(x => x.id === b.id)) throw httpErr(409, 'This bot already exists on the server.');
    if(b.type !== 'grid' && b.type !== 'dca') throw httpErr(400, 'Bot type must be grid or dca.');
    if(!BOT_EXCHANGES.includes(b.exchange)) throw httpErr(400, 'Trading Bots support Bybit or Binance.');
    if(b.mode !== 'live' && b.mode !== 'demo') throw httpErr(400, 'Mode must be live or demo.');
    if(!/^[A-Z0-9]{3,24}$/.test(String(b.symbol || ''))) throw httpErr(400, 'Bad symbol.');
    if(!liveCred(b.exchange, b.mode)) throw httpErr(412, `The server has no saved ${b.exchange} ${b.mode} API key yet — sync your keys first.`);
    if(S.tradingBots.some(x => x.exchange === b.exchange && x.mode === b.mode && x.symbol === b.symbol && (x.status === 'active' || x.status === 'deploying')))
      throw httpErr(409, `${b.symbol} already has a running bot on ${b.exchange} ${b.mode}.`);
    rollTradingBotsDay(Date.now());
    if(limits){
      if(num(limits.tbDailyProfitTargetPct)) S.tbDailyProfitTargetPct = limits.tbDailyProfitTargetPct;
      if(num(limits.tbDailyMaxLossPct)) S.tbDailyMaxLossPct = limits.tbDailyMaxLossPct;
    }
    if(S.tbDailyHalted) throw httpErr(423, `Paused for today: ${S.tbDailyHaltMessage || 'daily limit reached'}`);

    const bot = {
      id: b.id, type: b.type, exchange: b.exchange, mode: b.mode, symbol: b.symbol,
      createdAtMs: Date.now(), status: 'deploying', statusMessage: 'Deploying on the server…', statusIsError: false,
      realizedUsd: 0, runtime: {}, direction: b.direction, leverage: b.leverage, config: b.config || {},
      origin: b.origin, nickname: typeof b.nickname === 'string' ? b.nickname.slice(0, 60) : undefined, server: true, log: [],
    };
    if(b.type === 'grid'){
      const p = b.plan;
      if(!p || !Array.isArray(p.levels) || p.levels.length < 2 || p.levels.length > 200 || !p.levels.every(num)
        || !num(p.upper) || !num(p.lower) || !(p.upper > p.lower) || !num(p.mid) || !num(p.allocationUsd) || !(p.allocationUsd > 0)
        || !num(p.levelCount) || !num(p.leverage) || p.leverage < 1 || p.leverage > 125)
        throw httpErr(400, 'The grid plan is missing or invalid.');
      bot.plan = p; bot.investmentUsd = num(b.investmentUsd) ? b.investmentUsd : p.allocationUsd;
      bot.runtime = { levels: [], longStopSet: false, shortStopSet: false, recoveryAddsUsed: 0, recoveryAddedUsd: 0 };
      S.tbDayAnchorInvestmentUsd += bot.investmentUsd; // known up front for Grid; DCA adds its own once its plan is built
    } else {
      if(!bot.config || !(bot.config.baseOrderUsd > 0)) throw httpErr(400, 'A DCA bot needs a base order size.');
      bot.investmentUsd = null;
    }
    S.tradingBots.push(bot);
    saveSoon(); // saved BEFORE any order is placed, so a restart mid-deploy is recognised (and flagged) rather than forgotten
    const cred = liveCred(bot.exchange, bot.mode);
    const run = (async () => {
      try{
        if(bot.type === 'grid') await deployGridBotInstance(bot, cred);
        else await deployDcaBotInstance(bot, cred);
      }catch(err){
        bot.status = 'error';
        tradingBotLog(bot, `Deployment failed: ${err.message}`, true);
      } finally { deploying.delete(bot.id); await store.flushNow(); }
    })();
    deploying.set(bot.id, run);
    return bot;
  }

  // Pause flattens and parks the bot; Resume redeploys it fresh at the current market (same as the browser's Smart Bots).
  async function pauseBot(id){
    const bot = getBot(id);
    if(bot.status !== 'active' || bot.paused) throw httpErr(409, 'Only a running bot can be paused.');
    const cred = liveCred(bot.exchange, bot.mode);
    if(!cred) throw httpErr(412, `The server has no saved ${bot.exchange} ${bot.mode} key.`);
    tradingBotLog(bot, 'Pausing — cancelling pending orders and closing any open position…', false);
    const result = await closeBotPositionForcefully(bot, cred, 'PAUSED');
    if(!result.ok){ tradingBotLog(bot, `Could not flatten to pause: ${result.message} — still active, try again.`, true); throw httpErr(502, result.message || 'Flatten failed.'); }
    bot.paused = true;
    bot.runtime = bot.type === 'grid'
      ? { levels: [], longStopSet: false, shortStopSet: false, recoveryAddsUsed: 0, recoveryAddedUsd: 0, unrealizedUsd: null }
      : { avgEntryPrice: null, totalQty: 0, safetyOrders: [], tpAlgoId: null, slAlgoId: null, openedAtMs: null, balanceBeforeUsd: null, unrealizedUsd: null };
    tradingBotLog(bot, result.hadSomethingOpen ? `Paused — every pending order cancelled, open position closed at ${fmtUsd(result.netUsd)} realized. Resume to redeploy fresh at market.` : 'Paused — pending orders cancelled, nothing was open. Resume to redeploy fresh at market.', false);
    await store.flushNow();
    return bot;
  }

  async function resumeBot(id){
    const bot = getBot(id);
    if(!bot.paused) throw httpErr(409, 'This bot is not paused.');
    const cred = liveCred(bot.exchange, bot.mode);
    if(!cred) throw httpErr(412, `The server has no saved ${bot.exchange} ${bot.mode} key.`);
    tradingBotLog(bot, 'Resuming — redeploying at current market…', false);
    if(bot.type === 'grid'){
      const snap = await fetchSnapshot(bot.exchange, bot.symbol, '5m').catch(err => { tradingBotLog(bot, `Snapshot fetch failed: ${err.message}`, true); return null; });
      if(!snap) throw httpErr(502, 'Could not read the market to rebuild the grid.');
      const regime = classifyRegime(snap.h1, snap.m15);
      const range = suggestGridRange(snap, regime);
      const plan = buildManualGridPlan({ symbol: bot.symbol, direction: 'NEUTRAL', upper: range.upper, lower: range.lower, levelCount: bot.config.levelCount || 10, leverage: bot.leverage, investmentUsd: bot.investmentUsd });
      if(!plan){ tradingBotLog(bot, 'Could not rebuild a grid plan from current market data — still paused.', true); throw httpErr(502, 'Could not rebuild the grid plan.'); }
      bot.plan = plan;
      await deployGridBotInstance(bot, cred);
    } else {
      S.tbDayAnchorInvestmentUsd -= (bot.investmentUsd || 0); // deployDcaBotInstance re-adds the freshly computed amount
      await deployDcaBotInstance(bot, cred);
    }
    if(bot.status === 'active') bot.paused = false;
    await store.flushNow();
    return bot;
  }

  function removeBot(id){
    const bot = getBot(id);
    if(bot.status === 'active' || bot.status === 'deploying') throw httpErr(409, 'Stop this bot before deleting it.');
    S.tradingBots.splice(S.tradingBots.indexOf(bot), 1);
    saveSoon();
  }

  function renameBot(id, nickname){
    const bot = getBot(id);
    bot.nickname = String(nickname || '').trim().slice(0, 60) || undefined;
    saveSoon();
    return bot;
  }

  function getBot(id){
    const bot = S.tradingBots.find(b => b.id === id);
    if(!bot) throw httpErr(404, 'No such bot on the server.');
    return bot;
  }

  // A restart can interrupt a deployment half-way (some orders placed, bot never marked active). Don't guess: surface it.
  function recoverOnBoot(){
    for(const bot of S.tradingBots){
      if(bot.status === 'deploying'){
        bot.status = 'error';
        tradingBotLog(bot, 'The server restarted while this bot was deploying — some orders may already be resting on the exchange. Press Stop to cancel them, then create the bot again.', true);
      }
    }
    saveSoon();
  }

  function start(){
    recoverOnBoot();
    if(timer) return;
    timer = setInterval(() => { runCycle().catch(err => log.error && log.error('[bots] cycle error:', err.message)); }, cycleMs);
    if(timer.unref) timer.unref();
    setTimeout(() => runCycle().catch(() => {}), 3000).unref?.(); // catch up right after a restart instead of waiting a full interval
  }
  function shutdown(){ if(timer){ clearInterval(timer); timer = null; } store.close(); }

  // Change today's cross-bot limits and/or lift today's pause. This is the ONLY way (besides the UTC day
  // rollover) to clear a Daily Max Loss / Profit Target pause, because the pause lives on the server for
  // server-run bots — editing the % box in the browser alone never reached it.
  //   maxLossPct / profitTargetPct — new limits; if the pause no longer applies under them it is lifted.
  //   reset: true — also zero today's realized P&L counter and re-anchor it to the bots that are running
  //          right now, then lift the pause (the loss guard starts counting again from zero).
  const clampPct = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Removes the same bot trade stored twice (older versions booked a close from more than one code path) and takes
  // the extra P&L back out of the bots' Realized and of today's counter. Keeps the oldest copy of each trade.
  function repairDuplicateTrades(){
    const { kept, removed } = dedupeBotTrades(S.trades);
    if(!removed.length) return { removed: 0, netUsd: 0 };
    S.trades.length = 0; S.trades.push(...kept);
    const dayStart = (S.tbDayKey != null ? S.tbDayKey : Math.floor(Date.now() / 86_400_000)) * 86_400_000;
    let netUsd = 0;
    for(const t of removed){
      const n = Number(t.netUsd) || 0; netUsd += n;
      const bot = S.tradingBots.find(b => b.id === t.gridId);
      if(bot && bot.type === 'grid') bot.realizedUsd = (bot.realizedUsd || 0) - n;   // grid bots add each close; a DCA bot just stores its one close
      if((t.closedAtMs || 0) >= dayStart) S.tbDayRealizedUsd -= n;
    }
    store.touch();
    return { removed: removed.length, netUsd };
  }

  function updateDay(input){
    const { maxLossPct, profitTargetPct, reset, dedupe } = input || {};
    rollTradingBotsDay(Date.now());
    const repaired = dedupe === true ? repairDuplicateTrades() : null;
    if(num(maxLossPct)) S.tbDailyMaxLossPct = clampPct(maxLossPct, 0.5, 100);
    if(num(profitTargetPct)) S.tbDailyProfitTargetPct = clampPct(profitTargetPct, 0.5, 1000);
    if(reset === true){
      S.tbDayRealizedUsd = 0;
      S.tbDayAnchorInvestmentUsd = S.tradingBots
        .filter(b => (b.status === 'active' || b.status === 'deploying') && num(b.investmentUsd))
        .reduce((a, b) => a + b.investmentUsd, 0);
      S.tbDailyHalted = false; S.tbDailyHaltMessage = null; S.tbDailyHaltKind = null;
    } else if(S.tbDailyHalted){
      const pct = S.tbDayAnchorInvestmentUsd > 0 ? (S.tbDayRealizedUsd / S.tbDayAnchorInvestmentUsd) * 100 : 0;
      const breached = pct >= S.tbDailyProfitTargetPct || (S.tbDailyMaxLossPct && pct <= -S.tbDailyMaxLossPct);
      if(!breached){ S.tbDailyHalted = false; S.tbDailyHaltMessage = null; S.tbDailyHaltKind = null; }
    }
    store.touch();
    return { day: snapshot().day, repaired };
  }

  // "Reset Committed Margin" on the Trading Bots list, kept ON THE SERVER so every device/browser sees the
  // same counter (it used to be a flag in one browser's local storage and got overwritten by the server's
  // copy of each bot a few seconds later). Only bots that are no longer running are cleared.
  function resetCommittedMargin(){
    let count = 0, amount = 0;
    for(const b of S.tradingBots){
      if(b.status === 'active' || b.status === 'deploying' || b.marginExcluded || !(b.investmentUsd > 0)) continue;
      b.marginExcluded = true; count++; amount += b.investmentUsd;
    }
    store.touch();
    return { count, amount };
  }

  function snapshot(){
    return {
      bots: S.tradingBots,
      day: {
        tbDayKey: S.tbDayKey, tbDayAnchorInvestmentUsd: S.tbDayAnchorInvestmentUsd, tbDayRealizedUsd: S.tbDayRealizedUsd,
        tbDailyHalted: S.tbDailyHalted, tbDailyHaltMessage: S.tbDailyHaltMessage, tbDailyHaltKind: S.tbDailyHaltKind || null,
        tbDailyProfitTargetPct: S.tbDailyProfitTargetPct, tbDailyMaxLossPct: S.tbDailyMaxLossPct,
      },
    };
  }

  return { start, shutdown, runCycle, handoff, stopBot: stopTradingBot, pauseBot, resumeBot, removeBot, renameBot, updateDay, resetCommittedMargin, snapshot, getBot, deploying };
}

export function httpErr(status, message){ const e = new Error(message); e.status = status; return e; }
