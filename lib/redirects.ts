import * as fs from 'fs';

/**
 * Permanent redirects of the static site (`redirects`) — OPT-IN.
 *
 * A static build cannot answer with a status code: Astro's `redirects` in
 * static mode emits a meta-refresh page with a 200, which search engines
 * treat as a weaker signal than a real 301 and which loses the query string
 * (ad tracking parameters included). This answers 301 at the edge, in the
 * viewer-request function, before any rewrite.
 *
 * Format: comma-separated `from -> to` pairs, e.g.
 *
 *   redirects: "/old-page -> /, /en/old-page -> /en"
 *
 * `=` is deliberately not the separator: hereya splits a `-p` value on it.
 */
export interface RedirectRule {
  /** Normalized source path (no trailing slash, root excepted). */
  from: string;
  /** Target path, sent as the Location (same host). */
  to: string;
}

const PATH_RE = /^\/[^\s?#,]*$/;

function normalize(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  if (out.endsWith('/index.html')) out = out.slice(0, -'/index.html'.length);
  return out === '' ? '/' : out;
}

/**
 * Parses and validates `redirects`. Every mistake here would be silent in
 * production (a redirect that shadows a live page, a loop, a chain), so each
 * one throws at synth. `knownPaths` = the page paths of the build, when known.
 */
export function parseRedirects(
  raw: string | undefined,
  knownPaths?: string[],
): RedirectRule[] {
  const value = raw?.trim();
  if (!value) return [];
  const rules: RedirectRule[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const parts = entry.split('->').map((s) => s.trim());
    if (parts.length !== 2 || !PATH_RE.test(parts[0]) || !PATH_RE.test(parts[1])) {
      throw new Error(
        `redirects: '${entry}' is not a 'from -> to' pair of absolute paths ` +
          `(e.g. '/old-page -> /'). No query string, fragment or space in a path.`,
      );
    }
    const from = normalize(parts[0]);
    const to = parts[1];
    if (from === '/') {
      throw new Error(`redirects: the root '/' cannot be redirected.`);
    }
    if (from === normalize(to)) {
      throw new Error(`redirects: '${entry}' redirects a path to itself (a loop).`);
    }
    if (seen.has(from)) {
      throw new Error(`redirects: '${from}' is redirected twice.`);
    }
    seen.add(from);
    rules.push({ from, to });
  }
  for (const r of rules) {
    if (seen.has(normalize(r.to))) {
      throw new Error(
        `redirects: '${r.from} -> ${r.to}' points at another redirect. ` +
          `Point it at the final target: a chain costs a round trip per hop.`,
      );
    }
    if (knownPaths?.includes(r.from)) {
      throw new Error(
        `redirects: '${r.from}' is still a page of the build. The redirect ` +
          `would hide it for good. Remove the page, or the redirect.`,
      );
    }
  }
  return rules;
}

/** True when the frontend build is on disk (it is at deploy, after the build). */
export function distExists(distDir: string): boolean {
  return fs.existsSync(distDir) && fs.statSync(distDir).isDirectory();
}

/**
 * The code inserted in the viewer-request function. Empty without rules, so
 * the function is byte-for-byte what it was before the feature.
 */
export function buildRedirectPrelude(rules: RedirectRule[]): string {
  if (rules.length === 0) return '';
  const map: Record<string, string> = {};
  for (const r of rules) map[r.from] = r.to;
  return `
var REDIRECTS = ${JSON.stringify(map)};

function redirectTarget(uri) {
  var p = uri;
  try { p = decodeURIComponent(p); } catch (e) { /* keep raw */ }
  while (p.length > 1 && p.charAt(p.length - 1) === '/') {
    p = p.slice(0, -1);
  }
  if (p.endsWith('/index.html')) {
    p = p.slice(0, -'/index.html'.length);
  }
  return Object.prototype.hasOwnProperty.call(REDIRECTS, p) ? REDIRECTS[p] : null;
}

function queryString(qs) {
  var parts = [];
  for (var k in qs) {
    var v = qs[k];
    var values = v.multiValue ? v.multiValue : [v];
    for (var i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? k : k + '=' + values[i].value);
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}
`;
}

export function buildRedirectBlock(rules: RedirectRule[]): string {
  if (rules.length === 0) return '';
  return `
  // 1a. Permanent redirects (opt-in) — query string kept
  var target = redirectTarget(uri);
  if (target !== null) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: target + queryString(request.querystring || {}) } }
    };
  }
`;
}
