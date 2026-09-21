// Worker for quant-sweep.mjs — loads the candle dataset once, then runs one backtest per message.
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { runBacktest } from '../js/futures/backtest.js';
import { DEFAULT_FEE_CONFIG } from '../js/futures/costs.js';
import { STRATEGY_REGISTRY } from '../js/futures/setups.js';
import { sanitizeQuantConfig, QUANT_ID, QUANT_TYPE } from '../js/futures/quant/config.js';
import { setQuantConsole } from '../js/futures/quant/log.js';
setQuantConsole(false);

const ds = JSON.parse(fs.readFileSync(workerData.datasetPath, 'utf8'));
const S = ds.settings;

parentPort.on('message', async ({ id, name, over }) => {
  try{
    const strategies = {};
    for(const st of STRATEGY_REGISTRY) strategies[st.id] = false;   // Quant only (all other strategies explicitly OFF)
    strategies[QUANT_ID] = true;
    const quant = { ...sanitizeQuantConfig({ ...over, riskPct: S.riskPct, minConfidence: over.minConfidence ?? 70 }), log: false };
    const cfg = {
      exchange: S.exchange, strategies, minConfidence: quant.minConfidence, riskPctPerTrade: S.riskPct, leverage: S.leverage,
      feeConfig: { ...DEFAULT_FEE_CONFIG, [S.exchange]: { makerPct: S.makerPct, takerPct: S.takerPct } },
      quant,
    };
    const res = await runBacktest({
      candlesBySymbol: ds.candles, symbols: ds.symbols, cfg, startingEquity: S.startingEquity, intervalMinutes: 5,
      maxDailyLossPct: S.maxDailyLossPct, dailyProfitTargetPct: S.dailyProfitTargetPct,
      metaOverrides: { spreadPct: S.spreadPct, fundingRatePct: S.fundingRatePct },
    });
    const trades = res.trades.filter(t => t.setupType === QUANT_TYPE).map(t => ({
      openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs, symbol: t.symbol, dir: t.direction, netUsd: t.netUsd,
      R: t.quant ? t.quant.realizedR : null, exit: t.exitReason, stopPct: t.quant ? t.quant.stopDistPct : null,
      score: t.quant ? t.quant.score : null, setup: t.quant ? t.quant.setup : null, feesUsd: t.feesUsd,
    }));
    parentPort.postMessage({ id, name, ok: true, trades, diag: res.quantDiag ? res.quantDiag.counts : null });
  }catch(err){
    parentPort.postMessage({ id, name, ok: false, error: String(err && err.stack || err) });
  }
});
