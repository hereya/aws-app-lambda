import { execSync } from 'node:child_process';
import * as cdk from 'aws-cdk-lib';
import { CfnOutput, SecretValue } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { Construct } from 'constructs';
import * as path from 'path';

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // 1. Inputs
    // -----------------------------------------------------------------------

    const hereyaProjectRootDir = process.env['hereyaProjectRootDir'];
    if (!hereyaProjectRootDir) {
      throw new Error('hereyaProjectRootDir environment variable is required');
    }

    // -----------------------------------------------------------------------
    // Domain resolution.
    //
    // Two modes:
    //   A. External DNS. `domain` is pinned by the user (or by another
    //      package). The stack runs the legacy 3-custom-resource cert flow
    //      and emits DNS records for the user to add manually.
    //   B. Auto-Route53. `defaultRootDomain` (e.g. "example.com") points at
    //      a Route 53 hosted zone owned by the workspace. The effective
    //      domain is either `effectiveDomain` (already computed by a
    //      sibling package like hereya/postmark-app-server), or
    //      `${subdomainName}.${defaultRootDomain}`, or — as a last resort
    //      — `${stackName.toLowerCase()}.${defaultRootDomain}`. The stack
    //      creates an ACM cert with Route 53 DNS validation (one deploy,
    //      no manual records) and ALIAS A/AAAA records for apex+www that
    //      point at the CloudFront distribution.
    // -----------------------------------------------------------------------

    const explicitDomain = process.env['domain'];
    const defaultRootDomain = process.env['defaultRootDomain'];
    const subdomainName = process.env['subdomainName'];
    const effectiveDomainFromEnv = process.env['effectiveDomain'];

    let domain: string;
    let manageDnsInRoute53 = false;
    if (explicitDomain) {
      domain = explicitDomain;
    } else if (effectiveDomainFromEnv) {
      domain = effectiveDomainFromEnv;
      manageDnsInRoute53 = !!defaultRootDomain;
    } else if (subdomainName && defaultRootDomain) {
      domain = `${subdomainName}.${defaultRootDomain}`;
      manageDnsInRoute53 = true;
    } else if (defaultRootDomain) {
      // No subdomain pinned and no upstream `effectiveDomain`. Derive a
      // short, stable, DNS-friendly label from a hash of the stack name —
      // the raw stackName may be a long opaque id like "p-<guid>" in
      // the hereya CDK harness, which is not domain-friendly.
      const stableLabel =
        'app-' +
        crypto
          .createHash('sha256')
          .update(this.stackName)
          .digest('hex')
          .slice(0, 8);
      domain = `${stableLabel}.${defaultRootDomain}`;
      manageDnsInRoute53 = true;
    } else {
      throw new Error(
        'Set either `domain` (external DNS) OR `defaultRootDomain` ' +
          '(Route 53 auto-mode, optionally with `subdomainName` or an ' +
          'upstream package emitting `effectiveDomain`).',
      );
    }

    const backendDistFolder =
      process.env['backendDistFolder'] ?? 'apps/backend/dist';
    const frontendDistFolder =
      process.env['frontendDistFolder'] ?? 'apps/frontend/dist';
    const lambdaHandler = process.env['lambdaHandler'] ?? 'handler.handler';
    const lambdaMemoryMb = process.env['lambdaMemoryMb']
      ? parseInt(process.env['lambdaMemoryMb'])
      : 512;
    const lambdaTimeoutSec = process.env['lambdaTimeoutSec']
      ? parseInt(process.env['lambdaTimeoutSec'])
      : 30;
    const nodeRuntime = resolveNodeRuntime(process.env['nodeRuntime']);
    const isSpa = process.env['isSpa'] === 'true';

    // Migration support — when truthy (default), create a sibling Lambda that
    // runs database migrations and gate the app Lambda on it via a CFn Custom
    // Resource. The migration Lambda's handler is user-defined (see
    // `migrationHandler`); it can use any tool (Drizzle, node-pg-migrate,
    // Prisma, raw SQL, Knex, etc.) — the CDK does not import any migration
    // library. Set `runMigrations=false` to opt out (e.g. backend without a DB).
    const runMigrationsEnabled =
      (process.env['runMigrations'] ?? 'true') !== 'false';
    const migrationHandler =
      process.env['migrationHandler'] ?? 'migrate.handler';
    const migrationTimeoutSec = process.env['migrationTimeoutSec']
      ? parseInt(process.env['migrationTimeoutSec'])
      : 300; // 5 min — accommodates Aurora resume + multi-statement migrations
    const migrationMemoryMb = process.env['migrationMemoryMb']
      ? parseInt(process.env['migrationMemoryMb'])
      : 512;
    // Folder inside the backend bundle whose contents are hashed to decide
    // when to re-fire the migration Custom Resource. Default matches Drizzle's
    // `drizzle-kit generate` output. Override for other tools (e.g. `migrations`
    // for node-pg-migrate, `prisma/migrations` for Prisma, etc.).
    const migrationHashFolder =
      process.env['migrationHashFolder'] ?? 'drizzle';
    // Comma-separated list of file extensions counted when hashing the folder.
    // Default `.sql` covers most tools; set to `.sql,.js` etc. if your tool
    // emits other files that should also trigger re-runs.
    const migrationHashExtensions = (
      process.env['migrationHashExtensions'] ?? '.sql'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // -----------------------------------------------------------------------
    // 2. Parse hereyaProjectEnv and split into policy / secret / plain
    // -----------------------------------------------------------------------

    const env: Record<string, string> = JSON.parse(
      process.env['hereyaProjectEnv'] ?? '{}',
    );

    const policyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => key.startsWith('IAM_POLICY_') || key.startsWith('iamPolicy'),
      ),
    );

    const nonPolicyEnv = Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith('IAM_POLICY_') && !key.startsWith('iamPolicy'),
      ),
    );

    const secretEnvEntries: Array<[string, string]> = Object.entries(
      nonPolicyEnv,
    )
      .filter(([, value]) => (value as string).startsWith('secret://'))
      .map(([key, value]) => [
        key,
        (value as string).slice('secret://'.length),
      ]);

    const plainEnv: Record<string, string> = Object.fromEntries(
      Object.entries(nonPolicyEnv).filter(
        ([, value]) => !(value as string).startsWith('secret://'),
      ),
    );

    // Always expose `domain` AND the canonical public `appUrl` to the
    // Lambda so app code can build absolute URLs (e.g. OAuth issuer in
    // /.well-known/oauth-authorization-server) without trying to derive
    // them from the incoming request — `Host` is stripped by the
    // ALL_VIEWER_EXCEPT_HOST_HEADER origin request policy, so `req.url`
    // surfaces the API Gateway origin, not the public domain.
    //
    // The CfnOutput further below has the same value — the env var is
    // simply the runtime-side mirror of the deploy-side output.
    plainEnv['domain'] = domain;
    plainEnv['appUrl'] = `https://${domain}`;

    // -----------------------------------------------------------------------
    // 3. One consolidated Secrets Manager secret (only if any secret:// entries)
    // -----------------------------------------------------------------------

    let consolidatedSecret: secrets.Secret | undefined;
    if (secretEnvEntries.length > 0) {
      consolidatedSecret = new secrets.Secret(this, 'HereyaSecrets', {
        secretName: `/${this.stackName}/hereya-secrets`,
        secretStringValue: SecretValue.unsafePlainText(
          JSON.stringify(Object.fromEntries(secretEnvEntries)),
        ),
      });
    }

    // -----------------------------------------------------------------------
    // 4. Lambda function (pre-bundled — fromAsset, not NodejsFunction)
    //
    // The same code asset (apps/backend/dist) is reused by the migration
    // Lambda below — esbuild produces both `handler.js` and `migrate.js` in
    // the same bundle.
    // -----------------------------------------------------------------------

    const backendCode = lambda.Code.fromAsset(
      path.join(hereyaProjectRootDir, backendDistFolder),
    );

    // Helper that wires plainEnv + consolidatedSecret + policyEnv onto a Lambda.
    // Used for both the app handler and the migration handler so they have
    // identical credentials/env shape.
    const configureFunction = (lambdaFn: lambda.Function): void => {
      if (consolidatedSecret) {
        lambdaFn.addEnvironment(
          'HEREYA_SECRETS_ARN',
          consolidatedSecret.secretArn,
        );
        consolidatedSecret.grantRead(lambdaFn);
      }
      for (const [, value] of Object.entries(policyEnv)) {
        const policy = JSON.parse(value as string);
        for (const statement of policy.Statement) {
          lambdaFn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
        }
      }
    };

    const fn = new lambda.Function(this, 'Handler', {
      runtime: nodeRuntime,
      handler: lambdaHandler,
      code: backendCode,
      memorySize: lambdaMemoryMb,
      timeout: cdk.Duration.seconds(lambdaTimeoutSec),
      environment: plainEnv,
    });
    configureFunction(fn);

    // -----------------------------------------------------------------------
    // 4a. Migration Lambda + Custom Resource (deploy-time migrations)
    //
    // The migration Lambda imports the same backend bundle as the app Lambda;
    // its handler (default `migrate.handler`) is user-defined and may run
    // any tool (Drizzle, node-pg-migrate, Prisma, raw SQL, Knex, etc.). A
    // CloudFormation Custom Resource invokes the handler on every Create/Update
    // — but only when the contents of the configured migration-hash folder
    // change (we hash the folder at synth time and pass the hash as a CR
    // property, so CFn re-fires the CR only when migrations have actually
    // been added/edited). The folder defaults to `drizzle` (the Drizzle CLI's
    // output) but is fully configurable via `migrationHashFolder` +
    // `migrationHashExtensions`.
    //
    // The app Lambda has an explicit dependency on the migration CR, so the
    // stack will not switch traffic to a new app version until migrations
    // have completed successfully. Failed migrations roll the deploy back.
    // -----------------------------------------------------------------------

    let migrationResource: cdk.CustomResource | undefined;
    if (runMigrationsEnabled) {
      const migrationFn = new lambda.Function(this, 'MigrationHandler', {
        runtime: nodeRuntime,
        handler: migrationHandler,
        code: backendCode,
        memorySize: migrationMemoryMb,
        timeout: cdk.Duration.seconds(migrationTimeoutSec),
        environment: plainEnv,
      });
      configureFunction(migrationFn);

      const migrationProvider = new cr.Provider(this, 'MigrationProvider', {
        onEventHandler: migrationFn,
      });

      const migrationHash = hashMigrationFolder(
        path.join(hereyaProjectRootDir, backendDistFolder, migrationHashFolder),
        migrationHashExtensions,
      );

      migrationResource = new cdk.CustomResource(this, 'MigrationResource', {
        serviceToken: migrationProvider.serviceToken,
        resourceType: 'Custom::HereyaAppMigrations',
        properties: {
          // Re-runs the CR only when the migration files change. Drizzle's
          // migrator is idempotent so this is safe either way; this just
          // avoids no-op CR invocations on every deploy.
          migrationHash,
        },
      });

      // App Lambda must not see traffic until migrations complete.
      fn.node.addDependency(migrationResource);
    }

    // -----------------------------------------------------------------------
    // 5. API Gateway v2 HTTP API (default $default stage) — catch-all routes
    // -----------------------------------------------------------------------

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: this.stackName,
    });

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      fn,
    );

    httpApi.addRoutes({
      path: '/',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // -----------------------------------------------------------------------
    // 6. ACM cert
    //
    // Route 53 mode: DnsValidatedCertificate creates the cert in us-east-1
    // and validates it via Route 53 in the looked-up hosted zone. One
    // deploy. Aliases are attached immediately.
    //
    // External mode: legacy non-blocking flow with three chained
    // custom resources:
    //   a. RequestCertificate (idempotent via IdempotencyToken = hash(stackName))
    //   b. DescribeCertificate (capture Status + DomainValidationOptions)
    //   c. PutParameter (write /hereya/<stackName>/certStatus for next synth)
    // Three deploys: first creates the cert + emits DNS records, user adds
    // them, second captures ISSUED, third flips aliases on.
    // -----------------------------------------------------------------------

    // Branch state — populated by whichever path runs below.
    let certificateForDistribution: acm.ICertificate | undefined;
    let aliasesEnabledForDistribution = false;
    let certificateArnForOutput = '';
    let certificateStatusForOutput = '';
    let hostedZoneForAliases: route53.IHostedZone | undefined;

    // Validation-record outputs (only populated in external mode).
    let apexValidationName = '';
    let apexValidationType = '';
    let apexValidationValue = '';
    let wwwValidationName = '';
    let wwwValidationType = '';
    let wwwValidationValue = '';

    if (manageDnsInRoute53) {
      // ------------------- Route 53 auto-mode -------------------
      hostedZoneForAliases = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: defaultRootDomain!,
      });

      // DnsValidatedCertificate is deprecated but functional — it's the
      // only single-stack way to create a cross-region (us-east-1) ACM
      // cert with Route 53 validation. The modern alternative (separate
      // us-east-1 stack + crossRegionReferences) is significantly more
      // complex. Revisit when DnsValidatedCertificate is fully removed
      // from aws-cdk-lib.
      const cert = new acm.DnsValidatedCertificate(this, 'Cert', {
        domainName: domain,
        subjectAlternativeNames: [`www.${domain}`],
        hostedZone: hostedZoneForAliases,
        region: 'us-east-1',
        validation: acm.CertificateValidation.fromDns(hostedZoneForAliases),
      });
      certificateForDistribution = cert;
      certificateArnForOutput = cert.certificateArn;
      certificateStatusForOutput = 'ISSUED'; // synchronously waited for by the construct
      aliasesEnabledForDistribution = true;
    } else {
      // ------------------- External DNS mode (2-deploy flow) -------------------
      //
      // Two custom resources:
      //   a. RequestCertificate (idempotent via IdempotencyToken = hash(stackName))
      //   b. DescribeCertificate (captures Status + DomainValidationOptions)
      //
      // The Distribution's alias / ViewerCertificate fields are gated by a
      // CloudFormation CONDITION (`IsCertIssued`) evaluated against
      // DescribeCertCr's live `Certificate.Status` response at deploy time.
      // Pass 1: cert is PENDING → condition false → Distribution comes up
      // without aliases, validation DNS records emitted. User adds DNS
      // records, cert flips to ISSUED in ACM. Pass 2: condition true →
      // aliases + ACM cert attached in the same deploy.
      //
      // Why CfnCondition rather than a synth-time SSM lookup:
      //   • valueFromLookup's context provider silently returns the
      //     supplied default on AccessDenied / missing-param, with no way
      //     to distinguish from a real PENDING_VALIDATION.
      //   • SSM round-trip required a third deploy because synth ran
      //     before the CR could write the updated status.
      //   • A CFn Condition is the single source of truth, evaluated
      //     once per deploy against the live cert.

      const idempotencyToken = crypto
        .createHash('sha256')
        .update(`${this.stackName}-cert-v1`)
        .digest('hex')
        .slice(0, 32);

      const certPolicy = cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'acm:RequestCertificate',
            'acm:DescribeCertificate',
            'acm:ListCertificates',
          ],
          resources: ['*'],
        }),
      ]);

      const requestCertCr = new cr.AwsCustomResource(this, 'RequestCertCr', {
        resourceType: 'Custom::HereyaRequestCertificate',
        onCreate: {
          service: 'ACM',
          action: 'requestCertificate',
          region: 'us-east-1',
          parameters: {
            DomainName: domain,
            SubjectAlternativeNames: [`www.${domain}`],
            ValidationMethod: 'DNS',
            IdempotencyToken: idempotencyToken,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            'CertificateArn',
          ),
        },
        onUpdate: {
          service: 'ACM',
          action: 'requestCertificate',
          region: 'us-east-1',
          parameters: {
            DomainName: domain,
            SubjectAlternativeNames: [`www.${domain}`],
            ValidationMethod: 'DNS',
            IdempotencyToken: idempotencyToken,
          },
          physicalResourceId: cr.PhysicalResourceId.fromResponse(
            'CertificateArn',
          ),
        },
        policy: certPolicy,
        installLatestAwsSdk: false,
      });

      const certificateArn = requestCertCr.getResponseField('CertificateArn');
      certificateArnForOutput = certificateArn;

      // Describe the cert — captures Status + DomainValidationOptions for
      // BOTH the apex and www SAN. ACM has a known race here: when you
      // request a cert with `SubjectAlternativeNames`, ACM populates
      // `DomainValidationOptions[0].ResourceRecord` (apex) immediately but
      // takes a few extra seconds to fill in `DomainValidationOptions[1]`
      // (www). A one-shot AwsCustomResource that queries DescribeCertificate
      // right after RequestCertificate caches that partial response, and
      // any downstream Fn::GetAtt for the www record then errors with
      // "Vendor response doesn't contain ... attribute", which rolls the
      // whole stack back.
      //
      // Fix: a small inline Lambda that polls DescribeCertificate every
      // few seconds until both DomainValidationOptions entries have their
      // ResourceRecord populated, then returns the values as flat top-level
      // attributes. Wrapped in `cr.Provider` so we don't have to implement
      // the CFn custom-resource response protocol by hand.
      const describeCertOnEvent = new lambda.Function(
        this,
        'DescribeCertOnEvent',
        {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: 'index.handler',
          timeout: cdk.Duration.minutes(3),
          // Inline so the package stays single-file. AWS SDK v3 client-acm
          // is bundled with the Node 22 runtime — no `installLatestAwsSdk`
          // dance, no separate asset to ship.
          code: lambda.Code.fromInline(`
const { ACMClient, DescribeCertificateCommand } = require('@aws-sdk/client-acm');

exports.handler = async (event) => {
  const { RequestType, ResourceProperties = {} } = event;
  if (RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const certArn = ResourceProperties.CertificateArn;
  const region = ResourceProperties.Region || 'us-east-1';
  const client = new ACMClient({ region });
  const maxAttempts = 30; // 30 * 5s = 150s max
  const delayMs = 5000;
  for (let i = 0; i < maxAttempts; i++) {
    const result = await client.send(new DescribeCertificateCommand({ CertificateArn: certArn }));
    const dvo = (result.Certificate && result.Certificate.DomainValidationOptions) || [];
    const allReady = dvo.length >= 2 && dvo.every(d => d.ResourceRecord && d.ResourceRecord.Name);
    if (allReady) {
      return {
        PhysicalResourceId: 'cert-describe-' + certArn,
        Data: {
          Status: result.Certificate.Status,
          ApexValidationName: dvo[0].ResourceRecord.Name,
          ApexValidationType: dvo[0].ResourceRecord.Type,
          ApexValidationValue: dvo[0].ResourceRecord.Value,
          WwwValidationName: dvo[1].ResourceRecord.Name,
          WwwValidationType: dvo[1].ResourceRecord.Type,
          WwwValidationValue: dvo[1].ResourceRecord.Value,
        },
      };
    }
    console.log('[describe-cert] DomainValidationOptions not yet fully populated (attempt ' + (i + 1) + '/' + maxAttempts + '); sleeping ' + delayMs + 'ms');
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Timeout: ACM did not populate DomainValidationOptions for ' + certArn + ' after ' + (maxAttempts * delayMs / 1000) + 's');
};
`),
          initialPolicy: [
            new iam.PolicyStatement({
              actions: ['acm:DescribeCertificate'],
              resources: ['*'],
            }),
          ],
        },
      );

      const describeCertProvider = new cr.Provider(
        this,
        'DescribeCertProvider',
        {
          onEventHandler: describeCertOnEvent,
        },
      );

      const describeCertCr = new cdk.CustomResource(this, 'DescribeCertCr', {
        resourceType: 'Custom::HereyaDescribeCertificate',
        serviceToken: describeCertProvider.serviceToken,
        properties: {
          CertificateArn: certificateArn,
          Region: 'us-east-1',
          // Synth-time timestamp so each `hereya deploy` produces a
          // different Properties block; CFn dedupes byte-identical
          // properties and skips re-invocation otherwise, so a still-
          // PENDING_VALIDATION cert at create-time would stay cached and
          // the alias-attach branch would never light up across deploys.
          Trigger: new Date().toISOString(),
        },
      });
      describeCertCr.node.addDependency(requestCertCr);

      certificateStatusForOutput = describeCertCr.getAtt('Status').toString();

      // Validation records — apex + www. The Lambda flattened them into
      // top-level Data fields, so we read them via getAtt by name rather
      // than the old AwsCustomResource `Certificate.DomainValidationOptions.N.…`
      // path. Tokens here resolve at deploy time as before.
      apexValidationName = describeCertCr.getAtt('ApexValidationName').toString();
      apexValidationType = describeCertCr.getAtt('ApexValidationType').toString();
      apexValidationValue = describeCertCr.getAtt('ApexValidationValue').toString();
      wwwValidationName = describeCertCr.getAtt('WwwValidationName').toString();
      wwwValidationType = describeCertCr.getAtt('WwwValidationType').toString();
      wwwValidationValue = describeCertCr.getAtt('WwwValidationValue').toString();

      // Read the cert's live status from ACM at synth time and decide
      // whether to include alias config in the template. Keyed on domain
      // name (known at synth) — no SSM, no per-stack state.
      //
      // Pass 1: no cert in ACM yet (the deploy is about to create it via
      // RequestCertCr) → list returns empty → status = NOT_FOUND → aliases
      // off → Distribution comes up on default *.cloudfront.net cert.
      // Validation DNS records emitted as outputs for the user.
      //
      // Pass 2: cert exists in ACM and (post DNS-record propagation) has
      // status = ISSUED → aliases on → Distribution updated with aliases
      // + ACM cert in the same deploy.
      //
      // Why this works: ACM cert is the single source of truth, queried
      // directly. No CR caching, no SSM, no context-provider quirks.
      const certStatus = (() => {
        try {
          const out = execSync(
            `aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?DomainName=='${domain}'].Status | [0]" --output text`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim();
          return out || 'NOT_FOUND';
        } catch {
          return 'NOT_FOUND';
        }
      })();
      aliasesEnabledForDistribution = certStatus === 'ISSUED';
      if (aliasesEnabledForDistribution) {
        certificateForDistribution = acm.Certificate.fromCertificateArn(
          this,
          'CertRef',
          certificateArn,
        );
      }
    }

    // -----------------------------------------------------------------------
    // 8. S3 bucket + CloudFront distribution
    // -----------------------------------------------------------------------

    const bucket = new s3.Bucket(this, 'FrontendBucket', {
      accessControl: s3.BucketAccessControl.PRIVATE,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // -----------------------------------------------------------------------
    // 9. CloudFront Function — www→apex 301 + URL rewrite (templated at synth)
    // -----------------------------------------------------------------------

    const cfFunctionCode = buildCloudFrontFunctionCode({ domain, isSpa });
    const urlRewriteFunction = new cloudfront.Function(
      this,
      'UrlRewriteFunction',
      {
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(cfFunctionCode),
      },
    );

    // /api/* origin: strip "https://" off the APIGW endpoint to get the host
    const apiOriginDomain = cdk.Fn.select(
      2,
      cdk.Fn.split('/', httpApi.apiEndpoint),
    );

    // /api/* policies.
    //
    // Cache: we don't cache API responses, so use the AWS-managed
    // CACHING_DISABLED policy. CloudFront recently tightened validation
    // and now rejects CachePolicy specifying headerBehavior/cookieBehavior/
    // queryStringBehavior together with all-zero TTLs:
    //   "The parameter HeaderBehavior is invalid for policy with caching
    //    disabled."
    // Hence we move all forwarding decisions into the OriginRequestPolicy
    // below; with caching disabled there's no cache-key concern.
    //
    // OriginRequest: forward everything from the viewer except the Host
    // header (CloudFront sets that to the API Gateway origin domain).
    // That includes Authorization, Content-Type, custom headers, all
    // cookies, all query strings. Authorization is allowed here when
    // forwarded via "all viewer" — it's only forbidden in an explicit
    // `allowList()` of an OriginRequestPolicy. The managed
    // ALL_VIEWER_EXCEPT_HOST_HEADER policy is the canonical choice for
    // API origins behind CloudFront.
    const apiOriginRequestPolicy =
      cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER;
    const apiCachePolicy = cloudfront.CachePolicy.CACHING_DISABLED;

    const distributionProps: cloudfront.DistributionProps = {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          {
            function: urlRewriteFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: (() => {
        // The Lambda origin is shared by every backend behavior — the
        // /api/* surface for normal app traffic plus a handful of well-
        // known paths the MCP / OAuth specs require to live OUTSIDE
        // /api/* (RFC 8414 metadata MUST be at /.well-known/... at the
        // hosted-resource root, MCP clients connect to a clean /mcp,
        // etc.). All routes get the same caching-disabled + all-viewer
        // policy pair as /api/*.
        const apiBehavior: cloudfront.BehaviorOptions = {
          origin: new origins.HttpOrigin(apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
        };
        return {
          '/api/*': apiBehavior,
          // MCP Streamable-HTTP endpoint. POSTed JSON-RPC. Single
          // pattern, exact match — sub-paths under /mcp/* aren't used
          // by the transport in stateless mode.
          '/mcp': apiBehavior,
          // OAuth 2.1 authorization server (per the MCP auth spec):
          // /oauth/authorize, /oauth/token, /oauth/register, …
          '/oauth/*': apiBehavior,
          // RFC 8414 (auth-server metadata) + RFC 9728 (protected-
          // resource metadata, served at <resource>/.well-known/...).
          // Both metadata documents and any future well-known route
          // are routed to the Lambda. Note the wildcard captures the
          // entire .well-known subtree — if you ever add ACME http-01
          // challenge files you'll want a more specific behavior.
          '/.well-known/*': apiBehavior,
        };
      })(),
      errorResponses: isSpa
        ? [
            {
              httpStatus: 404,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
              ttl: cdk.Duration.seconds(0),
            },
            {
              httpStatus: 403,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
              ttl: cdk.Duration.seconds(0),
            },
          ]
        : undefined,
      ...(aliasesEnabledForDistribution && certificateForDistribution
        ? {
            domainNames: [domain, `www.${domain}`],
            certificate: certificateForDistribution,
          }
        : {}),
    };

    const distribution = new cloudfront.Distribution(
      this,
      'Distribution',
      distributionProps,
    );

    // -----------------------------------------------------------------------
    // 8b. Route 53 ALIAS records — only in auto-Route53 mode.
    //
    // CloudFront targets must be reached via Route 53 ALIAS A/AAAA records
    // (CNAMEs at the zone apex are not legal). We create both apex and www
    // since the cert covers both. The www alias works in tandem with the
    // CloudFront Function's www→apex 301 redirect; the alias just terminates
    // TLS so the redirect can fire on HTTPS.
    // -----------------------------------------------------------------------

    if (manageDnsInRoute53 && hostedZoneForAliases) {
      const aliasTarget = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      );

      new route53.ARecord(this, 'AppApexAlias', {
        zone: hostedZoneForAliases,
        recordName: domain,
        target: aliasTarget,
      });
      new route53.AaaaRecord(this, 'AppApexAliasAaaa', {
        zone: hostedZoneForAliases,
        recordName: domain,
        target: aliasTarget,
      });

      new route53.ARecord(this, 'AppWwwAlias', {
        zone: hostedZoneForAliases,
        recordName: `www.${domain}`,
        target: aliasTarget,
      });
      new route53.AaaaRecord(this, 'AppWwwAliasAaaa', {
        zone: hostedZoneForAliases,
        recordName: `www.${domain}`,
        target: aliasTarget,
      });
    }

    // -----------------------------------------------------------------------
    // 10. BucketDeployment — frontend assets + invalidate /*
    //
    // index.html cache-busting on every deploy is achieved via the
    // distribution invalidation (distributionPaths: ['/*']). Astro fingerprints
    // its static assets, so default long-cache is correct for /assets/*.
    // -----------------------------------------------------------------------

    new BucketDeployment(this, 'FrontendDeployment', {
      destinationBucket: bucket,
      sources: [
        Source.asset(path.join(hereyaProjectRootDir, frontendDistFolder)),
      ],
      distribution,
      distributionPaths: ['/*'],
    });

    // -----------------------------------------------------------------------
    // 11. CfnOutputs
    // -----------------------------------------------------------------------

    new CfnOutput(this, 'cloudfrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description:
        'CloudFront distribution URL (works immediately, before DNS/aliases)',
    });

    new CfnOutput(this, 'appUrl', {
      value: `https://${domain}`,
      description: 'Canonical app URL (active once aliases are attached)',
    });

    new CfnOutput(this, 'apiUrl', {
      value: `https://${domain}/api`,
      description: 'API base URL behind the same CloudFront distribution',
    });

    new CfnOutput(this, 'certificateArn', {
      value: certificateArnForOutput,
      description: 'ARN of the ACM certificate (us-east-1)',
    });

    new CfnOutput(this, 'certificateStatus', {
      value: certificateStatusForOutput,
      description:
        'Live status of the ACM cert (ISSUED in auto-Route53 mode; ' +
        'observed-by-CR value in external-DNS mode)',
    });

    new CfnOutput(this, 'manageDnsInRoute53', {
      value: String(manageDnsInRoute53),
      description:
        'True when the stack auto-creates DNS in Route 53 (no manual records needed)',
    });

    // External-DNS-mode-only outputs: records the user must add manually.
    // In auto-Route53 mode these are no-ops (records are created by the stack).
    if (!manageDnsInRoute53) {
      new CfnOutput(this, 'dnsRecordCertValidationApexName', {
        value: apexValidationName,
        description: 'ACM cert validation CNAME name (apex)',
      });
      new CfnOutput(this, 'dnsRecordCertValidationApexType', {
        value: apexValidationType,
        description: 'ACM cert validation CNAME type (apex)',
      });
      new CfnOutput(this, 'dnsRecordCertValidationApexValue', {
        value: apexValidationValue,
        description: 'ACM cert validation CNAME value (apex)',
      });
      new CfnOutput(this, 'dnsRecordCertValidationWwwName', {
        value: wwwValidationName,
        description: 'ACM cert validation CNAME name (www)',
      });
      new CfnOutput(this, 'dnsRecordCertValidationWwwType', {
        value: wwwValidationType,
        description: 'ACM cert validation CNAME type (www)',
      });
      new CfnOutput(this, 'dnsRecordCertValidationWwwValue', {
        value: wwwValidationValue,
        description: 'ACM cert validation CNAME value (www)',
      });

      new CfnOutput(this, 'dnsRecordCloudfrontApexName', { value: domain });
      new CfnOutput(this, 'dnsRecordCloudfrontApexType', {
        value: 'CNAME',
        description:
          'Use ALIAS/ANAME at apex if your DNS provider supports it',
      });
      new CfnOutput(this, 'dnsRecordCloudfrontApexValue', {
        value: distribution.distributionDomainName,
      });

      new CfnOutput(this, 'dnsRecordCloudfrontWwwName', {
        value: `www.${domain}`,
      });
      new CfnOutput(this, 'dnsRecordCloudfrontWwwType', { value: 'CNAME' });
      new CfnOutput(this, 'dnsRecordCloudfrontWwwValue', {
        value: distribution.distributionDomainName,
      });

      // Aggregated convenience output — single JSON array for copy-paste.
      const dnsRecordsToAddJson = cdk.Fn.sub(
        JSON.stringify([
          {
            purpose: 'acm-validation-apex',
            name: '${ApexValidationName}',
            type: '${ApexValidationType}',
            value: '${ApexValidationValue}',
          },
          {
            purpose: 'acm-validation-www',
            name: '${WwwValidationName}',
            type: '${WwwValidationType}',
            value: '${WwwValidationValue}',
          },
          {
            purpose: 'cloudfront-apex',
            name: domain,
            type: 'CNAME',
            value: '${CloudfrontDomain}',
          },
          {
            purpose: 'cloudfront-www',
            name: `www.${domain}`,
            type: 'CNAME',
            value: '${CloudfrontDomain}',
          },
        ]),
        {
          ApexValidationName: apexValidationName,
          ApexValidationType: apexValidationType,
          ApexValidationValue: apexValidationValue,
          WwwValidationName: wwwValidationName,
          WwwValidationType: wwwValidationType,
          WwwValidationValue: wwwValidationValue,
          CloudfrontDomain: distribution.distributionDomainName,
        },
      );

      new CfnOutput(this, 'dnsRecordsToAdd', {
        value: dnsRecordsToAddJson,
        description:
          'Aggregated JSON array of all DNS records to add in your external DNS provider',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Hashes the contents of the migrations folder (filenames + content) at synth
// time. The result is fed into the migration Custom Resource so CFn re-invokes
// the CR only when actual migration files change. Tool-agnostic — works for
// Drizzle (.sql files in drizzle/), node-pg-migrate (.sql in migrations/),
// Prisma (.sql in prisma/migrations/), or any tool that emits a stable folder
// of versioned files. If the folder is missing or empty (very first build
// before any migrations exist), we return a stable sentinel — the CR still
// fires once on initial Create, then no-ops until migrations exist.
//
// Recursive walk so nested layouts (Prisma's per-migration subfolders) work.
function hashMigrationFolder(folder: string, extensions: string[]): string {
  if (!fs.existsSync(folder)) return 'no-migrations';
  const matched: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (extensions.some((ext) => ent.name.endsWith(ext))) {
        matched.push(rel);
      }
    }
  };
  walk(folder, '');
  if (matched.length === 0) return 'no-migrations';
  const h = crypto.createHash('sha256');
  for (const rel of matched) {
    h.update(rel);
    h.update(fs.readFileSync(path.join(folder, rel)));
  }
  return h.digest('hex').slice(0, 16);
}

function resolveNodeRuntime(input: string | undefined): lambda.Runtime {
  if (!input) return lambda.Runtime.NODEJS_22_X;
  const map: Record<string, lambda.Runtime> = {
    'nodejs18.x': lambda.Runtime.NODEJS_18_X,
    'nodejs20.x': lambda.Runtime.NODEJS_20_X,
    'nodejs22.x': lambda.Runtime.NODEJS_22_X,
  };
  return map[input] ?? lambda.Runtime.NODEJS_22_X;
}

function buildCloudFrontFunctionCode(opts: {
  domain: string;
  isSpa: boolean;
}): string {
  const { domain, isSpa } = opts;
  // CloudFront Functions (JS_2_0) — runs at viewer-request. No async, no env.
  // Logic order: 1) www→apex 301, 2) URL rewrite (SPA or MPA).
  return `
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
