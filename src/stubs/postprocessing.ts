// Stand-in for the `postprocessing` package, aliased in vite.config.ts.
//
// n8ao's bundle imports `Pass` from `postprocessing` at module level for its
// N8AOPostPass (the pmndrs/postprocessing flavour). We only use N8AOPass, which
// builds on three's own EffectComposer, so the real library would be a large
// dependency for a class that is never instantiated. Replace this alias with
// the real package if N8AOPostPass is ever needed.
export class Pass {}
