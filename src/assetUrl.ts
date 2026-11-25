/**
 * Resolves a path under public/ against Vite's base, so runtime-built URLs keep working when
 * the site is served from a subpath (GitHub Pages project sites live at /<repo>/). Vite
 * rewrites asset URLs in index.html and CSS itself, but not string literals in TypeScript.
 */
export const assetUrl = (path: string): string =>
  import.meta.env.BASE_URL + path.replace(/^\//, '');
