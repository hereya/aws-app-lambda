import * as fs from 'fs';
import * as path from 'path';

/**
 * CloudFront Functions caps the code of one function at 10 KB. The guard sits
 * a little below so a site that grows by a page or two fails at synth with a
 * clear message rather than at deploy with CloudFront's.
 */
export const MAX_FUNCTION_CODE_BYTES = 9.5 * 1024;

/**
 * Inputs of the opt-in not-found handling (`notFoundPage`). Absent = the
 * viewer-request function is byte-for-byte what it was before the feature.
 */
export interface NotFoundOptions {
  /** URI of the site's not-found page, e.g. `/404.html`. */
  page: string;
  /** Normalized page paths that exist in the build (see collectKnownPagePaths). */
  knownPaths: string[];
}

/**
 * Walks a static build and returns every PAGE path it can serve, normalized
 * the way the functions normalize a request: no trailing slash, root is `/`.
 *
 *   index.html          -> /
 *   prix/index.html     -> /prix
 *   404.html            -> /404
 *   docs/guide.html     -> /docs/guide
 */
export function collectKnownPagePaths(distDir: string): string[] {
  const found = new Set<string>();
  const walk = (absDir: string, relSegments: string[]): void => {
    const entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(absDir, entry.name), [...relSegments, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const segments =
          entry.name === 'index.html'
            ? relSegments
            : [...relSegments, entry.name.slice(0, -'.html'.length)];
        found.add('/' + segments.join('/'));
      }
    }
  };
  walk(distDir, []);
  return [...found].sort();
}

/**
 * Validates `notFoundPage` against the build and returns the options the
 * function builders take. Every failure here would otherwise be silent in
 * production (an SPA that 404s its own routes, a rewrite to a missing key that
 * S3 answers with 403), so each one throws at synth.
 */
export function resolveNotFoundOptions(opts: {
  notFoundPage: string;
  isSpa: boolean;
  distDir: string;
}): NotFoundOptions {
  const { notFoundPage, isSpa, distDir } = opts;
  if (isSpa) {
    throw new Error(
      `notFoundPage cannot be combined with isSpa=true. An SPA serves ` +
        `index.html for every path and routes on the client, so the edge ` +
        `cannot tell an unknown route from a real one. Remove notFoundPage, ` +
        `or set isSpa=false for a multi-page build.`,
    );
  }
  if (!notFoundPage.startsWith('/')) {
    throw new Error(
      `notFoundPage must be an absolute URI path such as '/404.html', ` +
        `and got '${notFoundPage}'.`,
    );
  }
  const file = path.join(distDir, ...notFoundPage.split('/').filter(Boolean));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(
      `notFoundPage '${notFoundPage}' does not exist in the frontend build ` +
        `(${file}). Every unknown page would be rewritten to a missing ` +
        `object, which S3 answers with 403. Build the page, or fix the path.`,
    );
  }
  return { page: notFoundPage, knownPaths: collectKnownPagePaths(distDir) };
}

/**
 * The matching logic shared by BOTH functions, generated from one source so
 * the request side (which rewrites) and the response side (which sets the
 * status) cannot disagree about what an unknown page is.
 *
 * A path is a PAGE when its last segment has no dot (assets keep today's
 * behaviour). It is UNKNOWN when its normalized form — percent-decoded,
 * trailing `/` and trailing `/index.html` stripped, root `/` — is not in the
 * list the build produced.
 */
function buildNotFoundPrelude(nf: NotFoundOptions): string {
  const known: Record<string, 1> = {};
  for (const p of nf.knownPaths) known[p] = 1;
  return `
var NOT_FOUND_URI = ${JSON.stringify(nf.page)};
var KNOWN_PAGES = ${JSON.stringify(known)};

function normalizePagePath(uri) {
  var p = uri;
  try { p = decodeURIComponent(p); } catch (e) { /* keep raw */ }
  while (p.length > 1 && p.charAt(p.length - 1) === '/') {
    p = p.slice(0, -1);
  }
  if (p.endsWith('/index.html')) {
    p = p.slice(0, -'/index.html'.length);
  }
  return p === '' ? '/' : p;
}

function isUnknownPage(uri) {
  var last = uri.slice(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') !== -1) {
    return false;
  }
  return KNOWN_PAGES[normalizePagePath(uri)] !== 1;
}
`;
}

/**
 * Viewer-request function of the default (static) behaviour.
 * Logic order: 1) www→apex 301, 1b) unknown page → notFoundPage (opt-in),
 * 2) URL rewrite (SPA or MPA).
 */
export function buildCloudFrontFunctionCode(opts: {
  domain: string;
  isSpa: boolean;
  notFound?: NotFoundOptions;
}): string {
  const { domain, isSpa, notFound } = opts;
  // CloudFront Functions (JS_2_0) — runs at viewer-request. No async, no env.
  // With `notFound` absent, both insertions are empty strings and the output
  // is exactly the function this package has always shipped.
  const prelude = notFound ? buildNotFoundPrelude(notFound) : '';
  const notFoundBlock = notFound
    ? `
  // 1b. Unknown page -> the site's not-found page (status set at viewer-response)
  if (isUnknownPage(uri)) {
    request.uri = NOT_FOUND_URI;
    return request;
  }
`
    : '';
  return `${prelude}
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = request.headers.host && request.headers.host.value;

  // 1. www -> apex 301
  if (host === 'www.${domain}') {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${domain}' + uri } }
    };
  }
${notFoundBlock}
  // 2. URL rewrite (mirrors cloudfront-deploy package)
  var isSpa = ${isSpa ? 'true' : 'false'};
  if (isSpa) {
    if (uri === '/') {
      request.uri = '/index.html';
      return request;
    }
    if (uri.endsWith('/')) {
      request.uri = uri + 'index.html';
      return request;
    }
    if (!uri.includes('.')) {
      request.uri = '/index.html';
      return request;
    }
  } else {
    if (uri === '/') {
      request.uri = '/index.html';
      return request;
    }
    if (uri.endsWith('/')) {
      request.uri = uri + 'index.html';
      return request;
    }
    if (!uri.includes('.')) {
      request.uri = uri + '/index.html';
      return request;
    }
  }

  return request;
}
`;
}

/**
 * Viewer-response function of the default (static) behaviour, only created
 * with `notFoundPage`. It turns the 200 S3 returned for the not-found page
 * into a 404.
 *
 * AWS does not specify whether `event.request.uri` here holds the URI the
 * viewer sent or the one the viewer-request function rewrote, so both are
 * recognised: the rewritten one is the not-found page itself, the original
 * one is re-checked with the same rule.
 *
 * Only a 200 is changed. A 304 (a browser revalidating its cached copy of the
 * page), a 403 or a 5xx passes through untouched.
 */
export function buildNotFoundStatusFunctionCode(nf: NotFoundOptions): string {
  return `${buildNotFoundPrelude(nf)}
function handler(event) {
  var response = event.response;
  var uri = event.request.uri;
  if (response.statusCode === 200 && (uri === NOT_FOUND_URI || isUnknownPage(uri))) {
    response.statusCode = 404;
    response.statusDescription = 'Not Found';
  }
  return response;
}
`;
}

/** Throws when a generated function would exceed CloudFront's size cap. */
export function assertFunctionCodeSize(name: string, code: string): void {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_FUNCTION_CODE_BYTES) {
    throw new Error(
      `The generated ${name} CloudFront Function is ${bytes} bytes, above ` +
        `the ${MAX_FUNCTION_CODE_BYTES}-byte guard (CloudFront caps a ` +
        `function at 10 KB). With notFoundPage the list of known page paths ` +
        `is inlined into the code, and this build has too many pages for it. ` +
        `Remove notFoundPage for this site.`,
    );
  }
}
