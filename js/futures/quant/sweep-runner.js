// Browser-side orchestrator for the settings sweep: spreads configs over a few Web Workers so the page stays
// responsive and several cores are used. Returns [{ name, over, trades }] (failed configs are skipped, reported in `errors`).
export function runSweepInWorkers({ candles, symbols, settings, configs, onProgress, jobs }){
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  const nWorkers = Math.max(1, Math.min(jobs || 4, cores - 1, configs.length));
  return new Promise((resolve, reject) => {
    const results = [], errors = [], workers = [];
    let next = 0, done = 0, ready = 0, failedStart = false;
    const finish = () => { workers.forEach(w => w.terminate()); resolve({ results, errors, workers: nWorkers }); };
    const feed = (w) => {
      if(next < configs.length){ const id = next++; w.postMessage({ type: 'run', id, name: configs[id][0], over: configs[id][1] }); }
    };
    for(let k = 0; k < nWorkers; k++){
      let w;
      try{ w = new Worker(new URL('./sweep-worker.js', import.meta.url), { type: 'module' }); }
      catch(err){ workers.forEach(x => x.terminate()); return reject(new Error('This browser could not start a background worker: ' + err.message)); }
      workers.push(w);
      w.onerror = (ev) => {
        if(failedStart) return; failedStart = true;
        workers.forEach(x => x.terminate());
        reject(new Error('Background worker failed to load' + (ev && ev.message ? ': ' + ev.message : '') + ' — hard-refresh the page (Ctrl+Shift+R) so the new files load, then try again.'));
      };
      w.onmessage = (e) => {
        const m = e.data;
        if(m.type === 'ready'){ ready++; feed(w); return; }
        if(m.type === 'result'){
          done++;
          if(m.ok) results.push({ name: m.name, over: configs[m.id][1], trades: m.trades }); else errors.push(`${m.name}: ${m.error}`);
          if(onProgress) onProgress(done / configs.length, done, configs.length);
          if(done === configs.length) finish(); else feed(w);
        }
      };
      w.postMessage({ type: 'init', candles, symbols, settings });
    }
  });
}
