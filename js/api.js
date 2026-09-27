// =============================================================
// api.js — generic API communication helper.
// =============================================================

export async function fetchJSON(url){
  const res = await fetch(url, { method:'GET' });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
