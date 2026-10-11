export async function resolve(specifier, context, next){
  if(specifier === 'express') return { url: new URL('./express.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
