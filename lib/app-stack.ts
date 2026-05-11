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
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as crypto from 'crypto';
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

    const domain = process.env['domain'];
    if (!domain) {
      throw new Error('domain environment variable is required');
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

    // Always expose `domain` to the Lambda so app code can read it.
    plainEnv['domain'] = domain;

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
    // -----------------------------------------------------------------------

    const fn = new lambda.Function(this, 'Handler', {
      runtime: nodeRuntime,
      handler: lambdaHandler,
      code: lambda.Code.fromAsset(
        path.join(hereyaProjectRootDir, backendDistFolder),
      ),
      memorySize: lambdaMemoryMb,
      timeout: cdk.Duration.seconds(lambdaTimeoutSec),
      environment: plainEnv,
    });

    if (consolidatedSecret) {
      fn.addEnvironment('HEREYA_SECRETS_ARN', consolidatedSecret.secretArn);
      consolidatedSecret.grantRead(fn);
    }

    // Attach IAM policies discovered in hereyaProjectEnv
    for (const [, value] of Object.entries(policyEnv)) {
      const policy = JSON.parse(value as string);
      for (const statement of policy.Statement) {
        fn.addToRolePolicy(iam.PolicyStatement.fromJson(statement));
      }
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
    // 6. ACM cert via cr.AwsCustomResource (us-east-1, non-blocking)
    //
    // Three chained custom resources:
    //   a. RequestCertificate (idempotent via IdempotencyToken = hash(stackName))
    //   b. DescribeCertificate (capture Status + DomainValidationOptions)
    //   c. PutParameter (write /hereya/<stackName>/certStatus for next synth)
    // -----------------------------------------------------------------------

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
          'ssm:PutParameter',
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

    // Describe the cert — captures Status + DomainValidationOptions
    const describeCertCr = new cr.AwsCustomResource(this, 'DescribeCertCr', {
      resourceType: 'Custom::HereyaDescribeCertificate',
      onCreate: {
        service: 'ACM',
        action: 'describeCertificate',
        region: 'us-east-1',
        parameters: { CertificateArn: certificateArn },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${this.stackName}-cert-describe`,
        ),
      },
      onUpdate: {
        service: 'ACM',
        action: 'describeCertificate',
        region: 'us-east-1',
        parameters: { CertificateArn: certificateArn },
        physicalResourceId: cr.PhysicalResourceId.of(
          `${this.stackName}-cert-describe`,
        ),
      },
      policy: certPolicy,
      installLatestAwsSdk: false,
    });
    describeCertCr.node.addDependency(requestCertCr);

    const certificateStatus = describeCertCr.getResponseField(
      'Certificate.Status',
    );

    // Read the validation records — apex + www → two records typically.
    // CDK's getResponseField returns a token; we collect them as best we can:
    // ACM returns DomainValidationOptions as an array. Each entry has
    // ResourceRecord.{Name,Type,Value}. We expose each field as its own output.
    const apexValidationName = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Name',
    );
    const apexValidationType = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Type',
    );
    const apexValidationValue = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.0.ResourceRecord.Value',
    );
    const wwwValidationName = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.1.ResourceRecord.Name',
    );
    const wwwValidationType = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.1.ResourceRecord.Type',
    );
    const wwwValidationValue = describeCertCr.getResponseField(
      'Certificate.DomainValidationOptions.1.ResourceRecord.Value',
    );

    // Write the status to SSM so the next synth's valueFromLookup picks it up.
    const certStatusParamName = `/hereya/${this.stackName}/certStatus`;
    const putCertStatusCr = new cr.AwsCustomResource(
      this,
      'PutCertStatusCr',
      {
        resourceType: 'Custom::HereyaPutCertStatus',
        onCreate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: certStatusParamName,
            Value: certificateStatus,
            Type: 'String',
            Overwrite: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${this.stackName}-cert-status`,
          ),
        },
        onUpdate: {
          service: 'SSM',
          action: 'putParameter',
          parameters: {
            Name: certStatusParamName,
            Value: certificateStatus,
            Type: 'String',
            Overwrite: true,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${this.stackName}-cert-status`,
          ),
        },
        onDelete: {
          service: 'SSM',
          action: 'deleteParameter',
          parameters: { Name: certStatusParamName },
          ignoreErrorCodesMatching: 'ParameterNotFound',
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'ssm:PutParameter',
              'ssm:DeleteParameter',
              'ssm:GetParameter',
            ],
            // SSM PutParameter region defaults to the stack region — the
            // valueFromLookup in step 7 reads from the same region.
            resources: ['*'],
          }),
        ]),
        installLatestAwsSdk: false,
      },
    );
    putCertStatusCr.node.addDependency(describeCertCr);

    // -----------------------------------------------------------------------
    // 7. Conditional alias attachment via SSM lookup (synth-time)
    //
    // First synth: SSM parameter does not exist → valueFromLookup returns a
    // dummy placeholder string. aliasesEnabled is false → distribution comes
    // up without aliases. After the first deploy writes the parameter, the
    // next synth reads the real value; once ACM marks the cert ISSUED, the
    // next deploy flips aliases on.
    // -----------------------------------------------------------------------

    // The third argument is a default value used when the SSM parameter is
    // missing (first deploy, before the cert custom resource has written it).
    // The value resolves to the literal `defaultValue` placeholder until the
    // real parameter exists. Lookup failures (e.g. no AWS creds during a
    // dry-run synth) are swallowed so synth never fails on first run.
    let certStatusFromSsm = 'PENDING_VALIDATION';
    try {
      certStatusFromSsm = ssm.StringParameter.valueFromLookup(
        this,
        certStatusParamName,
        'PENDING_VALIDATION',
      );
    } catch (_e) {
      certStatusFromSsm = 'PENDING_VALIDATION';
    }
    const aliasesEnabled = certStatusFromSsm === 'ISSUED';

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

    // `Authorization` cannot be set on an OriginRequestPolicy
    // (CloudFront caches per cache-key, and Authorization controls the cache
    // key — it must be forwarded via the CachePolicy instead). `Content-Type`
    // is part of the request body, also handled by the CachePolicy. Cookies
    // ride along on the origin-request policy.
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'ApiOriginRequestPolicy',
      {
        cookieBehavior:
          cloudfront.OriginRequestCookieBehavior.allowList('hereya_sid'),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.none(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      },
    );

    // Custom cache policy with caching effectively disabled (ttl=0) but with
    // Authorization + Content-Type forwarded as part of the cache key. The
    // policy must opt out of cookies/query-strings here so the origin-request
    // policy alone controls those.
    const apiCachePolicy = new cloudfront.CachePolicy(
      this,
      'ApiCachePolicy',
      {
        defaultTtl: cdk.Duration.seconds(0),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(0),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
          'Authorization',
          'Content-Type',
        ),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      },
    );

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
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiOriginDomain, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
        },
      },
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
      ...(aliasesEnabled
        ? {
            domainNames: [domain, `www.${domain}`],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'CertRef',
              certificateArn,
            ),
          }
        : {}),
    };

    const distribution = new cloudfront.Distribution(
      this,
      'Distribution',
      distributionProps,
    );

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
      value: certificateArn,
      description: 'ARN of the ACM certificate (us-east-1)',
    });

    new CfnOutput(this, 'certificateStatus', {
      value: certificateStatus,
      description:
        'Live status of the ACM cert as observed by the custom resource',
    });

    // DNS records the user must add in their external DNS provider.
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

    new CfnOutput(this, 'dnsRecordCloudfrontApex', {
      value: JSON.stringify({
        // Use Fn substitution at synth-time
        name: domain,
        type: 'CNAME or ALIAS',
        value: '<see distribution.distributionDomainName output>',
      }),
      description:
        'DNS record for apex → CloudFront (CNAME flat or ALIAS depending on provider)',
    });
    new CfnOutput(this, 'dnsRecordCloudfrontApexName', { value: domain });
    new CfnOutput(this, 'dnsRecordCloudfrontApexType', {
      value: 'CNAME',
      description: 'Use ALIAS/ANAME at apex if your DNS provider supports it',
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
    // Note: `Fn.sub` is used to embed token-resolved values into a JSON shell.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
