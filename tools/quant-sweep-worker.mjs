// Worker for quant-sweep.mjs — loads the candle dataset once, then runs one backtest per message
// (the run itself lives in js/futures/quant/sweep.js, shared with the Backtest tab's button).
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import { runSweepConfig } from '../js/futures/quant/sweep.js';
import { setQuantConsole } from '../js/futures/quant/log.js';
setQuantConsole(false);

const ds = JSON.parse(fs.readFileSync(workerData.datasetPath, 'utf8'));
parentPort.on('message', async ({ id, name, over }) => {
  try{
    const trades = await runSweepConfig({ candles: ds.candles, symbols: ds.symbols, settings: ds.settings, over });
    parentPort.postMessage({ id, name, ok: true, trades });
  }catch(err){
    parentPort.postMessage({ id, name, ok: false, error: String((err && err.stack) || err) });
  }
});
