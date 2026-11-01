import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import {
  buildCloudFrontFunctionCode,
  buildNotFoundStatusFunctionCode,
  collectKnownPagePaths,
  NotFoundOptions,
} from '../lib/cloudfront-functions';

const FIXTURES = path.join(__dirname, 'fixtures');
const DOMAIN = 'example.com';

type Handler = (event: any) => any;

/** Evaluates a generated CloudFront Function and returns its `handler`. */
function load(code: string): Handler {
  return vm.runInNewContext(`${code}\n;handler`, {}) as Handler;
}

function requestEvent(uri: string, host = DOMAIN) {
  return { request: { uri, headers: { host: { value: host } } } };
}

function responseEvent(uri: string, statusCode = 200) {
  return {
    request: { uri, headers: { host: { value: DOMAIN } } },
    response: { statusCode, statusDescription: 'OK', headers: {} },
  };
}

const NF: NotFoundOptions = {
  page: '/404.html',
  knownPaths: ['/', '/404', '/en', '/prix', '/café'],
};

describe('viewer-request without notFoundPage', () => {
  it('is byte-for-byte the code shipped before the feature (MPA)', () => {
    const expected = fs.readFileSync(
      path.join(FIXTURES, 'viewer-request.mpa.example.com.txt'),
      'utf8',
    );
    assert.equal(
      buildCloudFrontFunctionCode({ domain: DOMAIN, isSpa: false }),
      expected,
    );
  });

  it('is byte-for-byte the code shipped before the feature (SPA)', () => {
    const expected = fs.readFileSync(
      path.join(FIXTURES, 'viewer-request.spa.example.com.txt'),
      'utf8',
    );
    assert.equal(
      buildCloudFrontFunctionCode({ domain: DOMAIN, isSpa: true }),
      expected,
    );
  });
});

describe('viewer-request with notFoundPage', () => {
  const handler = load(
    buildCloudFrontFunctionCode({ domain: DOMAIN, isSpa: false, notFound: NF }),
  );
  const rewrite = (uri: string) => handler(requestEvent(uri)).uri;

  const cases: Array<[string, string]> = [
    ['/', '/index.html'],
    ['/prix', '/prix/index.html'],
    ['/prix/', '/prix/index.html'],
    ['/prix/index.html', '/prix/index.html'],
    ['/en', '/en/index.html'],
    ['/caf%C3%A9', '/caf%C3%A9/index.html'],
    ['/n-existe-pas', '/404.html'],
    ['/n-existe-pas/', '/404.html'],
    ['/a/b/c', '/404.html'],
    ['/404.html', '/404.html'],
    ['/a.css', '/a.css'],
    ['/missing/app.js', '/missing/app.js'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(rewrite(input), expected);
    });
  }

  it('still redirects www to the apex before anything else', () => {
    const res = handler(requestEvent('/n-existe-pas', `www.${DOMAIN}`));
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location.value, `https://${DOMAIN}/n-existe-pas`);
  });
});

describe('viewer-response (status) function', () => {
  const handler = load(buildNotFoundStatusFunctionCode(NF));
  const status = (uri: string, statusCode = 200) =>
    handler(responseEvent(uri, statusCode)).statusCode;

  // Both the URI the viewer sent and the one viewer-request rewrote to,
  // since AWS does not specify which one viewer-response sees.
  const cases: Array<[string, number]> = [
    ['/', 200],
    ['/index.html', 200],
    ['/prix', 200],
    ['/prix/', 200],
    ['/prix/index.html', 200],
    ['/en', 200],
    ['/en/index.html', 200],
    ['/caf%C3%A9', 200],
    ['/n-existe-pas', 404],
    ['/n-existe-pas/', 404],
    ['/a/b/c', 404],
    ['/404.html', 404],
    ['/a.css', 200],
  ];
  for (const [uri, expected] of cases) {
    it(`${uri} -> ${expected}`, () => {
      assert.equal(status(uri), expected);
    });
  }

  it('sets the status description with the 404', () => {
    const res = handler(responseEvent('/n-existe-pas'));
    assert.equal(res.statusDescription, 'Not Found');
  });

  it('leaves non-200 responses untouched (304 revalidation, 403, 5xx)', () => {
    assert.equal(status('/404.html', 304), 304);
    assert.equal(status('/n-existe-pas', 403), 403);
    assert.equal(status('/n-existe-pas', 503), 503);
  });
});

describe('collectKnownPagePaths', () => {
  it('maps index.html to its directory and other .html files to their name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-pages-'));
    const files = [
      'index.html',
      '404.html',
      'prix/index.html',
      'en/index.html',
      'en/prix/index.html',
      'docs/guide.html',
      'assets/app.css',
      'favicon.svg',
    ];
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    assert.deepEqual(collectKnownPagePaths(dir), [
      '/',
      '/404',
      '/docs/guide',
      '/en',
      '/en/prix',
      '/prix',
    ]);
  });
});
