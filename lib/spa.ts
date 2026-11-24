import * as fs from 'fs';
import * as path from 'path';

/**
 * SPA fallback at the edge (`spaEdgeRewrite`) — OPT-IN, requires `isSpa=true`.
 *
 * The legacy SPA fallback is a pair of CloudFront custom error responses
 * (403/404 -> /index.html with 200). Those apply to the WHOLE distribution, so
 * a 403/404 the backend returns on /api/*, /mcp, /oauth/* or /.well-known/*
 * reaches the client as the app's HTML with a 200 — an OAuth or MCP client, or
 * a `fetch`, gets a web page instead of its JSON error.
 *
 * With `spaEdgeRewrite=true` the error responses are removed and the
 * viewer-request function of the DEFAULT (static) behaviour does the fallback
 * itself. Backend behaviours never run it, so their status passes through.
 */
export interface SpaEdgeOptions {
  /**
   * Directories of the build that hold their own `index.html`, normalized
   * like `/docs` (root excluded). A request for `/docs/` keeps being served
   * `/docs/index.html`; any other trailing-slash path gets the app shell.
   */
  indexDirs: string[];
  /**
   * CloudFront path patterns of the backend behaviours. The function is not
   * attached to them, so this is a second line: a request matching one is
   * left untouched if it ever reaches the function.
   */
  backendPatterns: string[];
}

/** Returns every directory of the build that contains an `index.html`. */
export function collectIndexDirectories(distDir: string): string[] {
  const found: string[] = [];
  const walk = (absDir: string, rel: string[]): void => {
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), [...rel, entry.name]);
      } else if (rel.length > 0 && entry.isFile() && entry.name === 'index.html') {
        found.push('/' + rel.join('/'));
      }
    }
  };
  walk(distDir, []);
  return found.sort();
}

/**
 * Reads `spaEdgeRewrite`. Anything but `true` keeps the legacy behaviour;
 * `true` without `isSpa=true` is refused, since there is no SPA to fall back to.
 */
export function resolveSpaEdgeRewrite(raw: string | undefined, isSpa: boolean): boolean {
  const on = raw?.trim() === 'true';
  if (on && !isSpa) {
    throw new Error(
      `spaEdgeRewrite=true requires isSpa=true: it replaces the SPA ` +
        `fallback, and a multi-page build has none. Remove spaEdgeRewrite, ` +
        `or set isSpa=true.`,
    );
  }
  return on;
}

/** CloudFront path pattern (`*`, `?` wildcards, case-sensitive) -> regex source. */
export function patternToRegexSource(pattern: string): string {
  const p = pattern.startsWith('/') ? pattern : '/' + pattern;
  let out = '^';
  for (const ch of p) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return out + '$';
}

export function buildSpaEdgePrelude(spa: SpaEdgeOptions): string {
  const dirs: Record<string, 1> = {};
  for (const d of spa.indexDirs) dirs[d] = 1;
  return `
var SPA_INDEX_DIRS = ${JSON.stringify(dirs)};
var BACKEND_PATTERNS = ${JSON.stringify(spa.backendPatterns.map(patternToRegexSource))};

function isBackendPath(uri) {
  for (var i = 0; i < BACKEND_PATTERNS.length; i++) {
    if (new RegExp(BACKEND_PATTERNS[i]).test(uri)) {
      return true;
    }
  }
  return false;
}

function hasOwnIndex(uri) {
  var p = uri;
  try { p = decodeURIComponent(p); } catch (e) { /* keep raw */ }
  while (p.length > 1 && p.charAt(p.length - 1) === '/') {
    p = p.slice(0, -1);
  }
  return SPA_INDEX_DIRS[p] === 1;
}
`;
}

/**
 * Section 2 of the viewer-request function in `spaEdgeRewrite` mode. The
 * querystring is a separate field of the event, so rewriting `uri` keeps it.
 */
export function buildSpaEdgeBlock(): string {
  return `
  // 2. SPA fallback at the edge (spaEdgeRewrite) — replaces the
  //    distribution-wide error responses, so backend 4xx pass through.
  if (isBackendPath(uri)) {
    return request;
  }
  var last = uri.slice(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') !== -1) {
    // A file: served as-is, or S3's own error when it does not exist.
    return request;
  }
  if (last === '' && uri !== '/' && hasOwnIndex(uri)) {
    request.uri = uri + 'index.html';
    return request;
  }
  request.uri = '/index.html';
  return request;
}
`;
}
