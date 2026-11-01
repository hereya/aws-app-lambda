import { after, before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AppStack } from '../lib/app-stack';

const FIXTURES = path.join(__dirname, 'fixtures');

// The stack reads its inputs from the environment at construction, and in
// external-DNS mode it shells out to `aws` at synth to read the certificate
// status (any failure there means "no certificate yet"). A stub `aws` that
// always fails keeps these tests offline and credential-free.
let tmpRoot: string;
let fakeBin: string;
const savedEnv = { ...process.env };

function makeProject(pages: string[]): string {
  const root = fs.mkdtempSync(path.join(tmpRoot, 'project-'));
  const backend = path.join(root, 'apps/backend/dist');
  fs.mkdirSync(backend, { recursive: true });
  fs.writeFileSync(path.join(backend, 'handler.js'), 'exports.handler=1;');
  for (const page of pages) {
    const file = path.join(root, 'apps/frontend/dist', page);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<html></html>');
  }
  return root;
}

const SITE = ['index.html', '404.html', 'prix/index.html', 'en/index.html'];

function synth(env: Record<string, string>): Template {
  process.env = {
    ...savedEnv,
    PATH: `${fakeBin}${path.delimiter}${savedEnv.PATH ?? ''}`,
    domain: 'example.com',
    ...env,
  };
  try {
    const app = new cdk.App({ outdir: fs.mkdtempSync(path.join(tmpRoot, 'out-')) });
    const stack = new AppStack(app, 'TestStack', {
      env: { account: '111111111111', region: 'eu-west-1' },
    });
    return Template.fromStack(stack);
  } finally {
    process.env = { ...savedEnv };
  }
}

function functions(t: Template): any[] {
  return Object.values(t.findResources('AWS::CloudFront::Function'));
}

function distributionConfig(t: Template): any {
  const [dist] = Object.values(t.findResources('AWS::CloudFront::Distribution'));
  return (dist as any).Properties.DistributionConfig;
}

function eventTypes(behaviour: any): string[] {
  return (behaviour.FunctionAssociations ?? []).map((a: any) => a.EventType);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-lambda-test-'));
  fakeBin = path.join(tmpRoot, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'aws'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('stack without notFoundPage', () => {
  for (const [isSpa, fixture] of [
    ['false', 'viewer-request.mpa.example.com.txt'],
    ['true', 'viewer-request.spa.example.com.txt'],
  ]) {
    it(`isSpa=${isSpa}: one viewer-request function, code unchanged`, () => {
      const t = synth({ hereyaProjectRootDir: makeProject(SITE), isSpa });
      const fns = functions(t);
      assert.equal(fns.length, 1);
      assert.equal(
        fns[0].Properties.FunctionCode,
        fs.readFileSync(path.join(FIXTURES, fixture), 'utf8'),
      );
      const config = distributionConfig(t);
      assert.deepEqual(eventTypes(config.DefaultCacheBehavior), ['viewer-request']);
      for (const b of config.CacheBehaviors) {
        assert.deepEqual(eventTypes(b), []);
      }
    });
  }
});

describe('stack with notFoundPage', () => {
  it('adds a viewer-response function on the default behaviour only', () => {
    const t = synth({
      hereyaProjectRootDir: makeProject(SITE),
      notFoundPage: '/404.html',
      viewerCountryPaths: '/api/m*',
    });
    assert.equal(functions(t).length, 2);
    const config = distributionConfig(t);
    assert.deepEqual(eventTypes(config.DefaultCacheBehavior), [
      'viewer-request',
      'viewer-response',
    ]);
    assert.ok(config.CacheBehaviors.length >= 5);
    for (const b of config.CacheBehaviors) {
      assert.deepEqual(eventTypes(b), [], `behaviour ${b.PathPattern}`);
    }
    assert.equal(config.CustomErrorResponses, undefined);
  });

  it('inlines the known page paths of the build', () => {
    const t = synth({
      hereyaProjectRootDir: makeProject(SITE),
      notFoundPage: '/404.html',
    });
    for (const fn of functions(t)) {
      assert.match(
        fn.Properties.FunctionCode,
        /var KNOWN_PAGES = \{"\/":1,"\/404":1,"\/en":1,"\/prix":1\};/,
      );
    }
  });

  it('refuses isSpa=true', () => {
    assert.throws(
      () =>
        synth({
          hereyaProjectRootDir: makeProject(SITE),
          notFoundPage: '/404.html',
          isSpa: 'true',
        }),
      /notFoundPage cannot be combined with isSpa=true/,
    );
  });

  it('refuses a page missing from the build', () => {
    assert.throws(
      () =>
        synth({
          hereyaProjectRootDir: makeProject(SITE),
          notFoundPage: '/not-there.html',
        }),
      /does not exist in the frontend build/,
    );
  });

  it('refuses a build whose page list would overflow the function size cap', () => {
    const many = Array.from(
      { length: 400 },
      (_, i) => `section-${i}/a-rather-long-page-name-${i}/index.html`,
    );
    assert.throws(
      () =>
        synth({
          hereyaProjectRootDir: makeProject([...SITE, ...many]),
          notFoundPage: '/404.html',
        }),
      /above the .*-byte guard/,
    );
  });
});

describe('stack with redirects', () => {
  it('inlines the rules in the viewer-request function', () => {
    const t = synth({
      hereyaProjectRootDir: makeProject(SITE),
      notFoundPage: '/404.html',
      redirects: '/old-page -> /, /en/old-page -> /en',
    });
    const codes = functions(t).map((f) => f.Properties.FunctionCode as string);
    const request = codes.find((c) => c.includes('var REDIRECTS'));
    assert.ok(request, 'viewer-request carries the rules');
    assert.match(request!, /var REDIRECTS = \{"\/old-page":"\/","\/en\/old-page":"\/en"\};/);
  });

  it('refuses a redirect that would hide a page of the build', () => {
    assert.throws(
      () =>
        synth({
          hereyaProjectRootDir: makeProject(SITE),
          redirects: '/prix -> /',
        }),
      /still a page of the build/,
    );
  });
});
