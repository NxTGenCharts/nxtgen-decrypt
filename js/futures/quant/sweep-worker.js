// Web Worker (module) for the Backtest tab's settings sweep. Receives the candle set once ('init'), then runs one
// config per 'run' message and posts back lightweight trade rows. No DOM access — the backtest engine is DOM-free.
import { runSweepConfig } from './sweep.js';
import { setQuantConsole } from './log.js';
setQuantConsole(false);
let data = null;
self.onmessage = async (e) => {
  const m = e.data;
  if(m.type === 'init'){ data = m; self.postMessage({ type: 'ready' }); return; }
  if(m.type === 'run'){
    try{
      const trades = await runSweepConfig({ candles: data.candles, symbols: data.symbols, settings: data.settings, over: m.over });
      self.postMessage({ type: 'result', id: m.id, name: m.name, ok: true, trades });
    }catch(err){
      self.postMessage({ type: 'result', id: m.id, name: m.name, ok: false, error: String((err && err.message) || err) });
    }
  }
};
