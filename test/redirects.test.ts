import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vm from 'vm';
import { buildCloudFrontFunctionCode } from '../lib/cloudfront-functions';
import { parseRedirects } from '../lib/redirects';

const DOMAIN = 'example.com';
const RAW = '/old-page -> /, /en/old-page/ -> /en';

function load(code: string): (event: any) => any {
  return vm.runInNewContext(`${code}\n;handler`, {}) as (event: any) => any;
}

function event(uri: string, querystring: Record<string, any> = {}, host = DOMAIN) {
  return { request: { uri, querystring, headers: { host: { value: host } } } };
}

describe('parseRedirects', () => {
  it('absent or empty = no rule', () => {
    assert.deepEqual(parseRedirects(undefined), []);
    assert.deepEqual(parseRedirects('  '), []);
  });

  it('parses and normalizes the sources', () => {
    assert.deepEqual(parseRedirects(RAW), [
      { from: '/old-page', to: '/' },
      { from: '/en/old-page', to: '/en' },
    ]);
  });

  const refused: Array<[string, RegExp]> = [
    ['/a', /not a 'from -> to' pair/],
    ['/a -> /b -> /c', /not a 'from -> to' pair/],
    ['a -> /b', /not a 'from -> to' pair/],
    ['/a?x=1 -> /b', /not a 'from -> to' pair/],
    ['/ -> /b', /root/],
    ['/a/ -> /a', /to itself/],
    ['/a -> /b, /a -> /c', /twice/],
    ['/a -> /b, /b -> /c', /another redirect/],
  ];
  for (const [raw, re] of refused) {
    it(`refuses '${raw}'`, () => {
      assert.throws(() => parseRedirects(raw), re);
    });
  }

  it('refuses a source that is still a page of the build', () => {
    assert.throws(
      () => parseRedirects(RAW, ['/', '/en', '/old-page']),
      /still a page of the build/,
    );
    assert.doesNotThrow(() => parseRedirects(RAW, ['/', '/en']));
  });
});

describe('viewer-request with redirects', () => {
  const rules = parseRedirects(RAW);
  for (const notFound of [undefined, { page: '/404.html', knownPaths: ['/', '/404', '/en'] }]) {
    const handler = load(
      buildCloudFrontFunctionCode({ domain: DOMAIN, isSpa: false, notFound, redirects: rules }),
    );
    const label = notFound ? 'with notFoundPage' : 'alone';

    const cases: Array<[string, string]> = [
      ['/old-page', '/'],
      ['/old-page/', '/'],
      ['/old-page/index.html', '/'],
      ['/en/old-page', '/en'],
      ['/en/old-page/', '/en'],
    ];
    for (const [uri, location] of cases) {
      it(`${label}: ${uri} -> 301 ${location}`, () => {
        const res = handler(event(uri));
        assert.equal(res.statusCode, 301);
        assert.equal(res.statusDescription, 'Moved Permanently');
        assert.equal(res.headers.location.value, location);
      });
    }

    it(`${label}: keeps the query string`, () => {
      const res = handler(
        event('/old-page', {
          utm_source: { value: 'ads' },
          tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
          flag: { value: '' },
        }),
      );
      assert.equal(res.headers.location.value, '/?utm_source=ads&tag=a&tag=b&flag');
    });

    it(`${label}: other paths keep the usual rewrite`, () => {
      assert.equal(handler(event('/en')).uri, '/en/index.html');
      assert.equal(handler(event('/old-page-2')).uri, notFound ? '/404.html' : '/old-page-2/index.html');
      assert.equal(handler(event('/old-page.css')).uri, '/old-page.css');
    });

    it(`${label}: www goes to the apex first`, () => {
      const res = handler(event('/old-page', {}, `www.${DOMAIN}`));
      assert.equal(res.headers.location.value, `https://${DOMAIN}/old-page`);
    });
  }
});
