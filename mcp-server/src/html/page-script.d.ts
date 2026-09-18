/**
 * The in-page collector, bundled to a standalone script at build time and
 * imported as text (see scripts/build.mjs).
 */
declare module 'page-script:collect' {
  const source: string;
  export default source;
}
