import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { buildCloudFrontFunctionCode } from '../lib/cloudfront-functions';
import { parseRedirects } from '../lib/redirects';
import {
  collectIndexDirectories,
  patternToRegexSource,
  resolveSpaEdgeRewrite,
  SpaEdgeOptions,
} from '../lib/spa';

const DOMAIN = 'example.com';
const BACKEND = ['/api/m*', '/api/*', '/mcp', '/oauth/*', '/.well-known/*'];
const SPA: SpaEdgeOptions = { indexDirs: ['/docs'], backendPatterns: BACKEND };

type Handler = (event: any) => any;

function load(code: string): Handler {
  return vm.runInNewContext(`${code}\n;handler`, {}) as Handler;
}

function requestEvent(uri: string, querystring: any = {}, host = DOMAIN) {
  return { request: { uri, querystring, headers: { host: { value: host } } } };
}

describe('viewer-request with spaEdgeRewrite', () => {
  const handler = load(
    buildCloudFrontFunctionCode({ domain: DOMAIN, isSpa: true, spaEdge: SPA }),
  );
  const rewrite = (uri: string) => handler(requestEvent(uri)).uri;

  // Same result as the legacy function + error responses for every deep link.
  const cases: Array<[string, string]> = [
    ['/', '/index.html'],
    ['/dashboard', '/index.html'],
    ['/users/42/edit', '/index.html'],
    ['/v1.2/settings', '/index.html'],
    ['/settings/', '/index.html'],
    ['/docs/', '/docs/index.html'],
    ['/docs', '/index.html'],
    ['/caf%C3%A9', '/index.html'],
    // Files are left to S3: served, or its own error when missing.
    ['/index.html', '/index.html'],
    ['/assets/app-3f2a.js', '/assets/app-3f2a.js'],
    ['/favicon.ico', '/favicon.ico'],
    ['/docs/index.html', '/docs/index.html'],
    // Backend paths never reach this function; if one did, it is untouched.
    ['/api/x', '/api/x'],
    ['/api/', '/api/'],
    ['/api/metrics', '/api/metrics'],
    ['/mcp', '/mcp'],
    ['/oauth/token', '/oauth/token'],
    ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(rewrite(input), expected);
    });
  }

  it('keeps the query string (a separate field, never touched)', () => {
    const qs = { code: { value: 'abc' }, state: { value: 'x y' } };
    const req = handler(requestEvent('/callback', qs));
    assert.equal(req.uri, '/index.html');
    assert.deepEqual(req.querystring, qs);
  });

  it('does not treat a lookalike of a backend path as backend', () => {
    assert.equal(rewrite('/apix'), '/index.html');
    assert.equal(rewrite('/mcp-docs'), '/index.html');
  });

  it('still redirects www to the apex first', () => {
    const res = handler(requestEvent('/dashboard', {}, `www.${DOMAIN}`));
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location.value, `https://${DOMAIN}/dashboard`);
  });

  it('composes with redirects in the same function', () => {
    const h = load(
      buildCloudFrontFunctionCode({
        domain: DOMAIN,
        isSpa: true,
        spaEdge: SPA,
        redirects: parseRedirects('/old -> /new'),
      }),
    );
    const res = h(requestEvent('/old', { a: { value: '1' } }));
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location.value, '/new?a=1');
    assert.equal(h(requestEvent('/new')).uri, '/index.html');
  });
});

describe('patternToRegexSource', () => {
  it('maps CloudFront wildcards and escapes the rest', () => {
    const re = (p: string) => new RegExp(patternToRegexSource(p));
    assert.ok(re('/.well-known/*').test('/.well-known/x'));
    assert.ok(!re('/.well-known/*').test('/awell-known/x'));
    assert.ok(re('/a?c').test('/abc'));
    assert.ok(re('/mcp').test('/mcp'));
    assert.ok(!re('/mcp').test('/mcp/x'));
  });
});

describe('resolveSpaEdgeRewrite', () => {
  it('is off unless exactly true', () => {
    assert.equal(resolveSpaEdgeRewrite(undefined, true), false);
    assert.equal(resolveSpaEdgeRewrite('false', true), false);
    assert.equal(resolveSpaEdgeRewrite('true', true), true);
  });

  it('refuses true without isSpa', () => {
    assert.throws(() => resolveSpaEdgeRewrite('true', false), /requires isSpa=true/);
  });
});

describe('collectIndexDirectories', () => {
  it('lists the directories holding an index.html, root excluded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-dirs-'));
    for (const f of ['index.html', 'docs/index.html', 'docs/guide.html', 'a/b/index.html', 'assets/app.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    assert.deepEqual(collectIndexDirectories(dir), ['/a/b', '/docs']);
  });
});
