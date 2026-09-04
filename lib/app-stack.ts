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
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
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
    // Scheduled wake — an EventBridge rule that invokes a DEDICATED handler
    // from the same backend bundle on a cron. Entirely OPT-IN: no
    // `scheduledWakeCron`, no rule, no Lambda, no permission, nothing added to
    // the stack. An app that says nothing about schedules deploys exactly as
    // it did before this feature existed.
    //
    // WHY A SEPARATE FUNCTION RATHER THAN A CRON ON THE APP HANDLER. The app
    // handler is an HTTP adapter (API Gateway event in, HTTP response out);
    // feeding it an EventBridge event means every app must grow a
    // shape-sniffing branch at its front door, and getting that branch wrong
    // breaks the website, not the cron. A second handler out of the same
    // bundle keeps the two invocation kinds physically apart — the app learns
    // "I was woken by the clock, not by a request" from WHICH ENTRY POINT ran,
    // which is unambiguous — and it inherits the same env, secrets and IAM as
    // the app through `configureFunction`. It is the exact shape the migration
    // Lambda already has, for the same reasons.
    const scheduledWakeCron = process.env['scheduledWakeCron']?.trim();
    const scheduledWakeHandler =
      process.env['scheduledWakeHandler'] ?? 'scheduled.handler';
    const scheduledWakeTimeoutSec = process.env['scheduledWakeTimeoutSec']
      ? parseInt(process.env['scheduledWakeTimeoutSec'])
      : 300; // 5 min — a sweep reads rows and sends mail; it is not a request
    const scheduledWakeMemoryMb = process.env['scheduledWakeMemoryMb']
      ? parseInt(process.env['scheduledWakeMemoryMb'])
      : 512;

    // WORK QUEUE — the other trigger for that same handler, and the one to
    // reach for first. Also entirely OPT-IN: no `workerQueue`, no queue, no
    // dead-letter queue, no event source, nothing added to the stack.
    //
    // WHY A QUEUE RATHER THAN A CRON, when the work is "do this off the
    // request path". A cron answers a question nobody asked: it wakes on the
    // clock, so it runs thousands of times to find nothing, it writes a log
    // line per tick saying so, and it still makes the caller wait up to a
    // whole period for work that was ready the instant they asked. A queue
    // inverts all three — the write IS the wake, so the handler runs when
    // there is something to do and at no other time, and it starts within a
    // second of the enqueue.
    //
    // It also hands over, for free, the three things a cron-driven worker has
    // to build by hand and usually builds wrong: RETRY (a failed invocation
    // redelivers), RECOVERY (an invocation killed mid-flight has its message
    // returned after the visibility timeout, rather than a row wedged in
    // `running` until some sweep notices), and a DEAD-LETTER QUEUE — a real
    // place where work that never succeeds lands and can be counted, instead
    // of disappearing into a log.
    //
    // THE HANDLER IS THE SAME ENTRY POINT as the cron's. An app may enable
    // either, or both; what changes is the event shape (an SQS event carries
    // `Records`, a scheduled event does not). One function, because it is one
    // job — "work I could not do inside the request" — and splitting it would
    // duplicate the bundle, the env, the IAM and the alarms for nothing.
    const workerQueueEnabled =
      (process.env['workerQueue'] ?? '').trim().toLowerCase() === 'true';
    // The visibility timeout is the RECOVERY DELAY: how long the queue waits
    // for a worker that stopped answering before handing the message to
    // another one. It MUST exceed the function timeout — otherwise the queue
    // redelivers a message to a second worker while the first is still
    // working on it, which is how the same 28 MB gets fetched twice. Default:
    // the function's own timeout plus a minute of margin for the cold start
    // and the SDK's own retries.
    const workerQueueVisibilityTimeoutSec = process.env[
      'workerQueueVisibilityTimeoutSec'
    ]
      ? parseInt(process.env['workerQueueVisibilityTimeoutSec'])
      : scheduledWakeTimeoutSec + 60;
    // How many deliveries before a message is set aside in the dead-letter
    // queue. Default 4 rather than 1: a transient failure (the provider was
    // slow, a token had just expired) is the common case and costs nothing to
    // retry, while a message that fails four times is telling you something.
    const workerQueueMaxReceiveCount = process.env['workerQueueMaxReceiveCount']
      ? parseInt(process.env['workerQueueMaxReceiveCount'])
      : 4;
    // One message per invocation by default. A batch is the right answer for
    // small, uniform items; this queue exists for the opposite — work that
    // takes minutes and can be killed by the clock — and a batch of those
    // fails together.
    const workerQueueBatchSize = process.env['workerQueueBatchSize']
      ? parseInt(process.env['workerQueueBatchSize'])
      : 1;
    // A ceiling on how many workers the queue may run at once. Left
    // unbounded, a burst of enqueues can take the whole account's Lambda
    // concurrency and starve the app handler that serves actual visitors —
    // the failure mode where a background job takes down the website. 2 is
    // the minimum AWS accepts.
    const workerQueueMaxConcurrency = process.env['workerQueueMaxConcurrency']
      ? parseInt(process.env['workerQueueMaxConcurrency'])
      : 2;

    // Alarms — OPT-IN, and the switch is the SNS topic you hand in.
    //
    // No `alertTopicArn`, no alarms: an app that says nothing about alerting
    // deploys exactly as it did before this feature existed, and pays nothing.
    // That is deliberate for a package this many projects share — CloudWatch
    // alarms are billed per alarm, and silently adding a handful to every
    // consumer's next deploy is not a decision this package gets to make.
    //
    // WHY A TOPIC ARN RATHER THAN A NOTIFICATION CHANNEL. Alarming and
    // NOTIFYING are different jobs. This package knows what is worth watching
    // in the stack it built; it knows nothing about who should be woken, in
    // which language, or through which medium. Handing it a topic keeps that
    // second half where it belongs — the consumer subscribes email, SMS, Chatbot
    // or its own relay Lambda, and can change its mind without redeploying the
    // app. The topic may live in ANOTHER stack: SNS's default topic policy
    // already lets CloudWatch publish from the same account, so a cross-stack
    // ARN needs no extra grant.
    //
    // Both directions are wired (ALARM and OK). An alert that never says "it is
    // over" trains its reader to ignore it. Note for subscribers: a brand-new
    // alarm is born INSUFFICIENT_DATA and flips to OK as soon as it can judge,
    // so the first deploy sends one OK per alarm unless the subscriber filters
    // on `OldStateValue === 'ALARM'`.
    const alertTopicArn = process.env['alertTopicArn']?.trim();

    // The one alarm that cannot be inferred: silence. A scheduled handler that
    // stops being invoked emits NO datapoint at all (not a zero), and no other
    // instrument in this stack mentions it — no request touches it, so it is
    // absent from every log and every error metric. Detecting that means
    // declaring how long silence is allowed to last, and only the app knows:
    // this package accepts any cron expression, from every minute to once a
    // month, so any window it picked for you would be wrong. Absent = no
    // silence alarm (the other alarms are unaffected).
    const scheduledWakeSilenceHours = process.env['scheduledWakeSilenceHours']
      ? parseInt(process.env['scheduledWakeSilenceHours'])
      : undefined;

    // Gateway ACCESS LOG — OPT-IN, and the switch is the retention you ask for.
    //
    // Same doctrine as `alertTopicArn` above: absent = no log group, no access
    // log, no per-route metrics, and a consumer that says nothing deploys and
    // pays exactly as before. A log group on every consumer's gateway is not a
    // decision this package gets to make — the bytes are billed to them.
    //
    // WHY IT IS WORTH ASKING FOR. `AWS/Lambda Errors` counts only invocations
    // that THREW. A handler that catches its own exception and returns a 500 —
    // which is what every framework does by default — leaves that metric at
    // zero. And a request that fails at the GATEWAY (502 malformed response,
    // 504 integration timeout, an authorizer refusal) never reaches the handler
    // at all, so it appears in no application log either. Between those two
    // facts, a whole class of failure is invisible unless the gateway itself is
    // asked to write down what it did.
    //
    // Measured, not theorised (dilaya.eu, 2026-08-26): ten gateway 5xx over one
    // evening while `AWS/Lambda Errors` read 0 for the full 24 h. They were
    // attributable only because the handler happened to log the exception
    // itself; a 502 or a 504 would have left nothing to attribute.
    //
    // WHY A RETENTION RATHER THAN A BOOLEAN: the number is not optional
    // information — an access log with no retention set keeps every line for
    // ever and quietly becomes the largest line on the bill. Making the value
    // the switch means the question is answered exactly once, by the consumer,
    // and cannot be forgotten.
    const accessLogRetentionDays = process.env['accessLogRetentionDays']
      ? parseInt(process.env['accessLogRetentionDays'])
      : undefined;

    // LOG ALARMS — OPT-IN, and the switch is the list itself.
    //
    // The gap this closes is the one none of the three alarms above can see: a
    // component that FAILS CLEANLY. A request refused on purpose is a 4xx, an
    // integration that answers "no" is a 200, and a handler that catches its
    // own error and writes a line about it never throws — so `Lambda Errors`
    // reads 0, `ApiGateway 5xx` reads 0, and the only witness is a sentence in
    // a log that nobody is watching at 3am.
    //
    // Measured, not theorised (dilaya.eu, 2026-08-27): 210 Stripe webhooks
    // refused for a bad signature over three hours. Every instrument in this
    // stack read zero throughout, because every one of them counts FAILURES
    // and this was a refusal working exactly as designed. It surfaced only in
    // a twice-daily manual sweep — and, read without enough detail in the line
    // itself, it surfaced as the WRONG incident.
    //
    // So: the consumer names the lines that must never appear, and each one
    // becomes a metric filter on the app handler's log group plus an alarm on
    // the same SNS topic as everything else. This package cannot know which
    // lines those are; it can only make it possible to say.
    //
    // Shape — a JSON array, because a YAML var is a string:
    //
    //   logAlarms: |
    //     [{"id":"StripeWebhookRejectedLive",
    //       "pattern":"\"[stripe-webhook] REJECTED live=true\"",
    //       "description":"A LIVE Stripe webhook was refused …"}]
    //
    // `pattern` is a CloudWatch FILTER PATTERN, passed through verbatim — the
    // quoting is CloudWatch's, not ours, and a package that tried to be clever
    // about it would silently change what matches. `threshold` (default 1) and
    // `periodMinutes` (default 5) are optional; the defaults say "once is
    // once too often", which is the only sensible floor for a line that must
    // never appear.
    const logAlarms = parseLogAlarms(process.env['logAlarms']);

    // A list with nowhere to publish is the failure this package must never
    // ship: CloudFormation would succeed, the metric filters would exist, and
    // nothing would ever fire. Loud at synth beats silent in production.
    if (logAlarms.length > 0 && !alertTopicArn) {
      throw new Error(
        `logAlarms lists ${logAlarms.length} alarm(s) but alertTopicArn is ` +
          `not set, so none of them could notify anyone. Set alertTopicArn, ` +
          `or remove logAlarms.`,
      );
    }

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

    // Every function that gets an Errors/Throttles alarm in section 10b.
    // Collected as they are built because the scheduled one is created inside a
    // feature-conditional block and would otherwise be out of scope there.
    const monitoredFunctions: { label: string; fn: lambda.Function }[] = [
      { label: 'Handler', fn },
    ];
    let scheduledFn: lambda.Function | undefined;
    let workerDlq: sqs.Queue | undefined;

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

      const backendDistDir = path.join(hereyaProjectRootDir, backendDistFolder);
      const migrationHash = hashMigrationInputs({
        folder: path.join(backendDistDir, migrationHashFolder),
        extensions: migrationHashExtensions,
        handlerFile: migrationHandlerFile(backendDistDir, migrationHandler),
      });

      migrationResource = new cdk.CustomResource(this, 'MigrationResource', {
        serviceToken: migrationProvider.serviceToken,
        resourceType: 'Custom::HereyaAppMigrations',
        properties: {
          // Re-runs the CR when the migration FILES change or when the
          // migration HANDLER itself changes — see hashMigrationInputs for why
          // the second half matters (code migrations live in the bundle, not in
          // a .sql folder, and hashing the folder alone left them inert).
          migrationHash,
        },
      });

      // App Lambda must not see traffic until migrations complete.
      fn.node.addDependency(migrationResource);
    }

    // -----------------------------------------------------------------------
    // 4b. Scheduled wake (opt-in) — EventBridge rule → dedicated handler
    //
    // For everything an app must do because TIME passed rather than because
    // someone called it: reminders before a deadline, notice before a
    // retention cut-off, any periodic sweep. Nothing here knows what the app
    // will do with the wake — it only guarantees the app is woken.
    //
    // The handler MUST be idempotent. EventBridge guarantees at-least-once
    // delivery, and a failed invocation is retried automatically, so a sweep
    // that mails on every run rather than on every DUE ITEM will eventually
    // mail twice. That is the single most likely way this feature hurts a
    // customer, and it is the app's job to prevent — see the README.
    // -----------------------------------------------------------------------

    if (scheduledWakeCron || workerQueueEnabled) {
      scheduledFn = new lambda.Function(this, 'ScheduledWakeHandler', {
        runtime: nodeRuntime,
        handler: scheduledWakeHandler,
        code: backendCode,
        memorySize: scheduledWakeMemoryMb,
        timeout: cdk.Duration.seconds(scheduledWakeTimeoutSec),
        environment: plainEnv,
      });
      configureFunction(scheduledFn);
      monitoredFunctions.push({ label: 'ScheduledWake', fn: scheduledFn });
      // Same ordering guarantee as the app Lambda: a sweep must never run
      // against a schema the pending migrations have not reached yet.
      if (migrationResource) scheduledFn.node.addDependency(migrationResource);

      new CfnOutput(this, 'scheduledWakeFunctionName', {
        value: scheduledFn.functionName,
        description: 'Lambda invoked on the scheduled-wake cron / work queue',
      });
    }

    if (scheduledFn && scheduledWakeCron) {
      new events.Rule(this, 'ScheduledWakeRule', {
        // `cron(...)` or `rate(...)` — passed through verbatim. Validating it
        // here would mean re-implementing EventBridge's grammar and going
        // stale; an invalid expression fails the deploy with EventBridge's own
        // message, which is more useful than one we would invent.
        schedule: events.Schedule.expression(scheduledWakeCron),
        description: `Scheduled wake for ${this.stackName}`,
        targets: [
          new targets.LambdaFunction(scheduledFn, {
            // Two attempts, then stop. A sweep is idempotent and runs again on
            // the next tick, so the default 24-hour, 185-retry policy would
            // only pile duplicate work onto an app already having a bad day.
            retryAttempts: 2,
            maxEventAge: cdk.Duration.minutes(30),
          }),
        ],
      });
    }

    // -----------------------------------------------------------------------
    // 4c. Work queue -> the same worker Lambda (see `workerQueue` above)
    //
    // The app handler is granted SendMessage and told the URL; the worker is
    // subscribed to the queue. Writing a message is the whole of "start this
    // job" from the app's side, and there is nothing to poll on either end.
    // -----------------------------------------------------------------------

    if (scheduledFn && workerQueueEnabled) {
      // WHY THE DEAD-LETTER QUEUE IS NOT OPTIONAL when the work queue is on.
      // Without it, a message that fails its last delivery is DELETED — the
      // work vanishes, and the only trace is a log line in a handler that had
      // already failed. With it, the message is still there tomorrow, holding
      // exactly what was asked for, and `ApproximateNumberOfMessagesVisible`
      // on it is a number an alarm can watch (see section 10b).
      workerDlq = new sqs.Queue(this, 'WorkerDlq', {
        // Long enough that a weekend does not swallow the evidence.
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
      });

      const workerQueue = new sqs.Queue(this, 'WorkerQueue', {
        visibilityTimeout: cdk.Duration.seconds(workerQueueVisibilityTimeoutSec),
        retentionPeriod: cdk.Duration.days(4),
        enforceSSL: true,
        deadLetterQueue: {
          queue: workerDlq,
          maxReceiveCount: workerQueueMaxReceiveCount,
        },
      });

      scheduledFn.addEventSource(
        new SqsEventSource(workerQueue, {
          batchSize: workerQueueBatchSize,
          maxConcurrency: workerQueueMaxConcurrency,
          // The handler decides, per message, whether the work is retryable:
          // it reports the ids it could not finish and those alone go back to
          // the queue. Without this, one message failing in a batch redelivers
          // every message in that batch — work already done, done again.
          reportBatchItemFailures: true,
        }),
      );

      // Both ends need the URL: the app enqueues, and a worker may split a
      // job into follow-up messages rather than hold one invocation open.
      workerQueue.grantSendMessages(fn);
      workerQueue.grantSendMessages(scheduledFn);
      fn.addEnvironment('workerQueueUrl', workerQueue.queueUrl);
      scheduledFn.addEnvironment('workerQueueUrl', workerQueue.queueUrl);

      new CfnOutput(this, 'workerQueueUrl', {
        value: workerQueue.queueUrl,
        description: 'SQS queue whose messages invoke the worker Lambda',
      });
      new CfnOutput(this, 'workerDlqUrl', {
        value: workerDlq.queueUrl,
        description: 'Dead-letter queue for work that never succeeded',
      });
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

    // Access log + per-route metrics on the `$default` stage (opt-in — see
    // `accessLogRetentionDays` in section 1).
    if (accessLogRetentionDays !== undefined) {
      const accessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogs', {
        retention: retentionFromDays(accessLogRetentionDays),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      // The settings live only on the L1 stage: `HttpApi` exposes no prop for
      // them, and `defaultStage` is the one `createDefaultStage` made for us.
      const cfnDefaultStage = httpApi.defaultStage!.node
        .defaultChild as apigwv2.CfnStage;
      cfnDefaultStage.accessLogSettings = {
        destinationArn: accessLogGroup.logGroupArn,
        // One JSON object per request, ordered by what a reader actually needs:
        // the status first, then WHY (a 5xx with `integrationStatus` absent is
        // a gateway fault; the same status with `integrationStatus: 200` is the
        // handler's own chosen response — a different bug entirely), then WHO
        // (ip/ua, which separates a scanner from one of your own components).
        format: JSON.stringify({
          requestId: '$context.requestId',
          requestTime: '$context.requestTime',
          httpMethod: '$context.httpMethod',
          routeKey: '$context.routeKey',
          path: '$context.path',
          status: '$context.status',
          integrationStatus: '$context.integrationStatus',
          integrationErrorMessage: '$context.integrationErrorMessage',
          integrationLatency: '$context.integrationLatency',
          responseLatency: '$context.responseLatency',
          errorMessage: '$context.error.message',
          authorizerError: '$context.authorizer.error',
          sourceIp: '$context.identity.sourceIp',
          userAgent: '$context.identity.userAgent',
        }),
      };

      // Per-route `5xx`/`4xx`/`Count`/`Latency`. Without this the 5xx metric
      // exists only at the API level — you learn that something failed, never
      // which route, which is the difference between a finding and a rumour.
      cfnDefaultStage.defaultRouteSettings = {
        ...(cfnDefaultStage.defaultRouteSettings as
          | apigwv2.CfnStage.RouteSettingsProperty
          | undefined),
        detailedMetricsEnabled: true,
      };

      new CfnOutput(this, 'httpApiAccessLogGroup', {
        value: accessLogGroup.logGroupName,
        description: 'CloudWatch log group receiving the HTTP API access log',
      });
    }

    // -----------------------------------------------------------------------
    // 6. ACM cert
    //
    // Route 53 mode: DnsValidatedCertificate creates the cert in us-east-1
    // and validates it via Route 53 in the looked-up hosted zone. One
    // deploy. Aliases are attached immediately.
    //
    // External mode: two-pass, non-blocking flow with three custom
    // resources — RequestCertificate (cert lifecycle), TagCertCr
    // (stamps `hereya:stackName=<this>` on the cert), and
    // DescribeCertificate (polls for validation records + Status).
    // Whether the L2 Distribution gets domainNames + cert is gated
    // by a SYNTH-time AWS lookup that prefers the tagged cert and
    // falls back to the prior CFn `certificateArn` output so existing
    // <0.5.3 deploys upgrade without re-issuing the cert. See the
    // long comment block in the External-DNS branch below for the
    // per-scenario flow.
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
      // Three custom resources:
      //   a. RequestCertificate — idempotent via IdempotencyToken.
      //      Inputs are stable across versions; do not change them or
      //      ACM will mint a new cert and orphan the existing one on
      //      upgrade (ACM's idempotency window is ~1h, long expired
      //      for any deploy that's been running for a while).
      //   b. AddTagsToCertificate — runs after (a) and tags the cert
      //      with `hereya:stackName=<this.stackName>` so a synth-time
      //      lookup can pick THIS stack's cert out of any other certs
      //      that may exist in the account for the same hostname.
      //      Implemented as a separate CR rather than the `Tags`
      //      inline param on (a) precisely so (a)'s Properties stay
      //      byte-identical and existing <0.5.3 deploys can upgrade
      //      without re-issuing the cert.
      //   c. DescribeCertificate — polls until DomainValidationOptions
      //      are populated; returns Status + flattened validation
      //      records (used as CFn outputs for the operator).
      //
      // Whether the L2 Distribution gets domainNames + cert is decided
      // at SYNTH time by readTaggedCertStatus(): list ACM certs in
      // us-east-1 matching the domain, narrow to the one tagged for
      // this stack, return its Status. On the very first 0.5.3 deploy
      // of an existing <0.5.3 stack the tag isn't there YET (TagCertCr
      // runs at deploy time, AFTER synth), so the helper falls back to
      // reading this stack's prior `certificateArn` CloudFormation
      // output and uses that ARN's live Status. Subsequent deploys hit
      // the by-tag fast path directly.
      //
      // Flow per scenario:
      //   • Existing successful <0.5.3 stack upgrades to 0.5.3:
      //       synth Phase 1: no tagged cert → Phase 2: stack output
      //       points at existing cert → ISSUED → aliases stay on.
      //       Deploy: RequestCertCr unchanged (byte-identical) → not
      //       re-invoked. TagCertCr Creates → tags existing cert.
      //       No outage, no cert churn.
      //   • Fresh stack, pass 1:
      //       synth: no tagged cert, no prior output → NOT_FOUND →
      //       aliases off, Distribution comes up on default
      //       *.cloudfront.net cert. Deploy: RequestCertCr creates a
      //       new cert; TagCertCr tags it. DNS records emitted as
      //       outputs. Operator copies records to their DNS provider;
      //       ACM validates; cert flips to ISSUED.
      //   • Fresh stack, pass 2:
      //       synth: tagged cert found, Status = ISSUED → aliases on.
      //       Distribution updated with aliases + cert in one deploy.
      //
      // Why the tag scopes the lookup (and not just DomainName):
      //   A pre-existing ISSUED cert for the same hostname elsewhere
      //   in the account — e.g. left over from a previously hand-
      //   rolled CloudFront — would otherwise satisfy a by-domain
      //   lookup. The stack would mark aliases enabled and wire this
      //   stack's freshly-requested PENDING cert into the
      //   Distribution; CFn deploys the change; CloudFront rejects
      //   any ViewerCertificate that isn't ISSUED with a 400 and
      //   rolls the whole stack back before any DNS-record outputs
      //   are emitted. The tag (and the stack-output fallback) scope
      //   the lookup to certs THIS stack owns.
      //
      // Why synth-time and not a deploy-time CFn Condition keyed on
      // `Fn::GetAtt: [DescribeCertCr, Status]`:
      //   CloudFormation evaluates Conditions before resources are
      //   created. A Condition that depends on a resource attribute
      //   fails with "Unresolved dependencies [<resource>]". An
      //   earlier 0.5.0 build tried exactly that and had to be
      //   reverted (commit a7125e4) — synth-time is the only path
      //   that works without a third deploy.

      // CRITICAL: do not change this token or any other RequestCertCr
      // input across versions. ACM's IdempotencyToken window is ~1h,
      // which means existing deploys' certs have long since aged out
      // of the window — so any change to this CR's Properties would
      // cause CFn to fire the CR's Update event, and ACM (outside the
      // window) would mint a brand-new cert. That would orphan the
      // existing cert, drop the Distribution's aliases until the new
      // cert is validated, and force the operator to add a fresh set
      // of ACM validation records. Tagging in 0.5.3 is therefore done
      // by a SEPARATE TagCertCr below (new resource, only fires
      // Create), not by adding Tags inline here.
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

      // Tag the cert with this stack's name so the synth-time
      // tag-filtered lookup below can pick it out of any other cert
      // in the account that happens to share the same DomainName.
      //
      // We use a SEPARATE custom resource (not the Tags inline param
      // on RequestCertificate above) for backward compatibility: this
      // CR is new in 0.5.3, so on existing <0.5.3 stacks CFn creates
      // it for the first time and tags whichever cert RequestCertCr
      // currently references — without disturbing RequestCertCr
      // itself, whose Properties stay byte-identical to <0.5.3 so CFn
      // does not fire its Update event and ACM does not mint a fresh
      // cert. On fresh stacks the CR Creates against the cert that
      // RequestCertCr just minted, also tagging it. Either way the
      // tag is in place by the time the next deploy's synth runs.
      const tagCertCr = new cr.AwsCustomResource(this, 'TagCertCr', {
        resourceType: 'Custom::HereyaTagCertificate',
        onCreate: {
          service: 'ACM',
          action: 'addTagsToCertificate',
          region: 'us-east-1',
          parameters: {
            CertificateArn: certificateArn,
            Tags: [{ Key: 'hereya:stackName', Value: this.stackName }],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${this.stackName}-cert-tag-v1`,
          ),
        },
        onUpdate: {
          service: 'ACM',
          action: 'addTagsToCertificate',
          region: 'us-east-1',
          parameters: {
            CertificateArn: certificateArn,
            Tags: [{ Key: 'hereya:stackName', Value: this.stackName }],
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${this.stackName}-cert-tag-v1`,
          ),
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['acm:AddTagsToCertificate'],
            resources: ['*'],
          }),
        ]),
        installLatestAwsSdk: false,
      });
      tagCertCr.node.addDependency(requestCertCr);

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

      // Synth-time lookup: read the live Status of THIS stack's cert
      // (identified by the `hereya:stackName` tag) and use it to decide
      // whether the L2 Distribution gets aliases + cert this deploy.
      //
      //   pass 1: RequestCertCr hasn't run yet → no cert exists with
      //   our tag → NOT_FOUND → aliases off → distribution comes up
      //   on the default *.cloudfront.net cert + emits DNS records.
      //
      //   pass 2: tagged cert exists in ACM. Status is whatever ACM
      //   currently reports — ISSUED if the operator has added the
      //   DNS records and ACM has validated, still PENDING_VALIDATION
      //   otherwise (deploy is a no-op for the alias config in that
      //   case; the operator runs hereya deploy again later).
      //
      // The pipeline is intentionally three small `aws` calls rather
      // than one because:
      //   • ListCertificates can return SUMMARY rows but not tags.
      //   • Filtering by tag therefore needs ListTagsForCertificate
      //     per candidate ARN.
      //   • DescribeCertificate gives the authoritative Status.
      // In practice the candidate list is 1–2 ARNs for a given domain,
      // so the loop is cheap.
      const certStatus = readTaggedCertStatus({
        certRegion: 'us-east-1',
        stackRegion:
          process.env['CDK_DEFAULT_REGION'] ??
          process.env['awsRegion'] ??
          'us-east-1',
        domain,
        stackName: this.stackName,
      });
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
    // 10b. Alarms (opt-in — see `alertTopicArn` in section 1)
    //
    // Three instruments, each blind to what the others see. That is the point:
    // every gap this package has had was found by ADDING an instrument, never
    // by reading an existing one more carefully.
    //
    //   - `AWS/Lambda Errors` sees a handler that throws, and nothing else.
    //   - `AWS/ApiGateway 5xx` sees what Lambda Errors structurally CANNOT: a
    //     502 malformed response, a refused integration, a 504 integration
    //     timeout. None of those make the function throw, so the Lambda metric
    //     stays flat at zero while every visitor gets an error page.
    //   - the silence alarm sees a scheduled handler that stopped being called
    //     at all — a failure with no error, no log line and no request.
    //
    // Thresholds are 1-in-5-minutes because the expected floor is exactly zero:
    // against an empirically zero baseline, "at least one" is the smallest
    // signal that means something happened, not a noisy one. `4xx` is
    // deliberately NOT alarmed — public endpoints take a constant drizzle of
    // scanner traffic, and alarming it teaches its reader to ignore the topic.
    //
    // The migration Lambda is deliberately absent: a failed migration already
    // fails and rolls back the deploy, in front of whoever is deploying.
    // -----------------------------------------------------------------------

    if (alertTopicArn) {
      const alertTopic = sns.Topic.fromTopicArn(
        this,
        'AlertTopic',
        alertTopicArn,
      );
      const alertAction = new cwActions.SnsAction(alertTopic);
      const alertOn = (alarm: cloudwatch.Alarm): void => {
        alarm.addAlarmAction(alertAction);
        alarm.addOkAction(alertAction);
      };

      for (const { label, fn: monitored } of monitoredFunctions) {
        for (const [metricName, metric] of [
          ['Errors', monitored.metricErrors()],
          ['Throttles', monitored.metricThrottles()],
        ] as const) {
          alertOn(
            new cloudwatch.Alarm(this, `${label}${metricName}Alarm`, {
              metric: metric.with({
                period: cdk.Duration.minutes(5),
                statistic: 'Sum',
              }),
              threshold: 1,
              evaluationPeriods: 1,
              comparisonOperator:
                cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
              // A function nobody called reports no datapoint; that is silence,
              // not failure. BREACHING here would fire on every quiet night.
              treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
              alarmDescription:
                `${domain} — ${label} Lambda ${metricName} >= 1 in 5 min ` +
                `(expected floor is 0). Stack ${this.stackName}.`,
            }),
          );
        }
      }

      alertOn(
        new cloudwatch.Alarm(this, 'HttpApi5xxAlarm', {
          metric: new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5xx',
            dimensionsMap: { ApiId: httpApi.apiId },
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            `${domain} — API Gateway 5xx >= 1 in 5 min. The Lambda error ` +
            `metric cannot see this class of failure: a 502/504 means the ` +
            `response was malformed or the integration never answered, and ` +
            `neither makes the function throw. Stack ${this.stackName}.`,
        }),
      );

      if (scheduledFn && scheduledWakeCron && scheduledWakeSilenceHours) {
        alertOn(
          new cloudwatch.Alarm(this, 'ScheduledWakeSilenceAlarm', {
            metric: scheduledFn.metricInvocations({
              period: cdk.Duration.hours(scheduledWakeSilenceHours),
              statistic: 'Sum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
            // Absence IS the signal here, so missing data must breach — the
            // inverse of every other alarm above. A handler that is never
            // invoked publishes nothing at all, so NOT_BREACHING would make
            // this alarm blind to the exact thing it exists to catch.
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
            alarmDescription:
              `${domain} — the scheduled handler has not run once in ` +
              `${scheduledWakeSilenceHours}h (cron ${scheduledWakeCron}). ` +
              `Whatever it does because time passed — reminders, sweeps, ` +
              `renewals — has stopped, silently. Stack ${this.stackName}.`,
          }),
        );
      }

      // Work that never succeeded. Unlike silence, this one needs no window
      // from the consumer: a message in the dead-letter queue is, by
      // construction, work that was asked for, tried `maxReceiveCount` times,
      // and never done. There is no healthy reading above zero.
      //
      // It is also the only instrument that sees this failure at all. The
      // worker's Errors alarm fires on the individual invocations — but those
      // are RETRIED, so a job that eventually lands is a resolved incident,
      // and a job that never lands looks identical from that metric. The
      // difference between the two is exactly what this queue holds.
      if (workerDlq) {
        alertOn(
          new cloudwatch.Alarm(this, 'WorkerDlqAlarm', {
            metric: workerDlq.metricApproximateNumberOfMessagesVisible({
              period: cdk.Duration.minutes(5),
              statistic: 'Maximum',
            }),
            threshold: 1,
            evaluationPeriods: 1,
            comparisonOperator:
              cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            // An empty queue does publish a zero, so absent data here means
            // the metric itself stopped — not a reason to wake anyone.
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription:
              `${domain} — background work landed in the dead-letter queue: ` +
              `it was requested, retried ${workerQueueMaxReceiveCount} times ` +
              `and never completed. Whoever asked for it is still waiting. ` +
              `Stack ${this.stackName}.`,
          }),
        );
      }

      // Log-line alarms (see `logAlarms` in section 1). One metric filter per
      // entry on the app handler's log group, and one alarm on the metric it
      // publishes.
      //
      // `treatMissingData: NOT_BREACHING` — a filter that matches nothing
      // publishes no datapoint at all, and "the bad line did not appear" is
      // the healthy state, not an absence of information.
      for (const entry of logAlarms) {
        const filter = new logs.MetricFilter(this, `${entry.id}MetricFilter`, {
          logGroup: fn.logGroup,
          filterPattern: logs.FilterPattern.literal(entry.pattern),
          // SEPARATED BY NAMESPACE, NOT BY DIMENSION — and that is not a
          // stylistic choice. Two facts about CloudWatch Logs, neither of
          // which CDK checks at synth (both measured against the real API on
          // 2026-08-27, the second one the hard way, on a production deploy
          // that failed and rolled back):
          //
          //   1. `dimensions` and `defaultValue` are mutually exclusive on a
          //      metric transformation — the service answers 400.
          //   2. `dimensions` require a filter pattern that EXTRACTS named
          //      fields (JSON or space-delimited). A plain substring pattern,
          //      which is what "this line must never appear" always is, gets
          //      "The specified filter pattern does not support dimensions".
          //
          // So a substring filter cannot be dimensioned at all, and the stack
          // has to be part of the NAMESPACE instead. Separation still matters
          // for the same reason it always did: the metric name comes from the
          // consumer, so two apps picking the same id would otherwise add
          // their counts together and each alarm would fire on the other's
          // events.
          //
          // ⚠️ A GREEN `cdk synth` IS NOT A VALIDATION OF THE API CONTRACT.
          // Both shapes above synthesise perfectly.
          metricNamespace: `${LOG_ALARM_NAMESPACE}/${this.stackName}`,
          metricName: entry.id,
          // Now that dimensions are gone, this is allowed — and it earns its
          // place: the filter publishes an explicit 0 for every period with no
          // match, so the alarm has a continuous series to judge instead of a
          // sparse one. A sparse metric takes three periods to be called
          // healthy again after a firing; a dense one recovers in one.
          metricValue: '1',
          defaultValue: 0,
        });

        alertOn(
          new cloudwatch.Alarm(this, `${entry.id}LogAlarm`, {
            metric: filter.metric({
              period: cdk.Duration.minutes(entry.periodMinutes),
              statistic: 'Sum',
            }),
            threshold: entry.threshold,
            evaluationPeriods: 1,
            comparisonOperator:
              cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
            alarmDescription:
              `${domain} — ${entry.description} ` +
              `(>= ${entry.threshold} matching log line(s) in ` +
              `${entry.periodMinutes} min; pattern ${entry.pattern}). ` +
              `Stack ${this.stackName}.`,
          }),
        );
      }

      new CfnOutput(this, 'alertTopicArn', {
        value: alertTopicArn,
        description: 'SNS topic this stack publishes its alarm states to',
      });
    }

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

// What decides whether the migration Custom Resource re-fires, hashed at synth
// time from TWO inputs:
//
//   1. the migrations FOLDER (filenames + content) — Drizzle's `drizzle/*.sql`,
//      node-pg-migrate's `migrations/`, Prisma's `prisma/migrations/`, …;
//   2. the migration HANDLER's own compiled file — because a migration does not
//      have to be a .sql file. A handler that runs code migrations (a list of
//      one-shot functions gated by a sentinel row, a common pattern for
//      key/value stores that have no SQL at all) ships its migrations INSIDE
//      the bundle, and folder-only hashing never notices them.
//
// Before 0.5.4 only (1) was hashed. A project with no SQL folder therefore
// produced the constant `no-migrations`, CloudFormation saw an unchanged
// property on every subsequent deploy, and the Custom Resource fired exactly
// ONCE — at stack creation. Its handler was faithfully redeployed forever after
// and never invoked again: migrations shipped, believed applied, silently
// inert. That failure is invisible precisely because nothing errors.
//
// Cost of the wider hash: at most one extra Lambda invocation per deploy, on
// deploys that touch the backend bundle. A migration runner is expected to be
// idempotent (Drizzle's is; the sentinel pattern is by construction), so a
// no-op invocation is the intended cheap outcome. Nothing is replaced or
// recreated — the CR gates the app Lambda's rollout, it does not rebuild it.
export function hashMigrationInputs(opts: {
  folder: string;
  extensions: string[];
  /** Compiled migration handler file, e.g. `<dist>/migrate.js`. Missing (a
   *  handler that isn't a plain file in the bundle) → folder hash only. */
  handlerFile?: string;
}): string {
  const folderHash = hashMigrationFolder(opts.folder, opts.extensions);
  if (!opts.handlerFile || !fs.existsSync(opts.handlerFile)) return folderHash;
  const h = crypto.createHash('sha256');
  h.update(folderHash);
  h.update(fs.readFileSync(opts.handlerFile));
  return `${folderHash}-${h.digest('hex').slice(0, 16)}`;
}

/** `migrate.handler` → `<dist>/migrate.js` (or .mjs / .cjs). Returns undefined
 *  when no such file exists, which keeps the pre-0.5.4 behaviour for any layout
 *  this guess does not fit — a wrong guess must degrade to "folder only", never
 *  to a wrong hash. */
export function migrationHandlerFile(
  distDir: string,
  handler: string,
): string | undefined {
  const dot = handler.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const base = path.join(distDir, handler.slice(0, dot));
  for (const ext of ['.js', '.mjs', '.cjs']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return undefined;
}

// Hashes the contents of the migrations folder (filenames + content). If the
// folder is missing or empty (very first build before any migrations exist), we
// return a stable sentinel.
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

// Reads the live Status of the ACM cert this stack uses. Two phases:
//
//   1. By-tag (preferred): list ACM certs in `certRegion` matching
//      the domain, fetch tags per candidate, pick the one carrying
//      `hereya:stackName=<stackName>`, return its Status.
//
//   2. By-stack-output (backward-compat fallback): if no tagged cert
//      is found, query CloudFormation for THIS stack's prior
//      `certificateArn` output. If present, describe that cert; if
//      its DomainName matches, return its Status. This handles the
//      first 0.5.3 deploy of an existing <0.5.3 stack — the cert
//      isn't tagged YET (TagCertCr runs at deploy time, AFTER this
//      synth-time lookup), but the stack's own output tells us
//      unambiguously which cert is ours.
//
// Returns 'NOT_FOUND' on first-ever deploy of a new stack (no cert
// exists yet, no prior output), on any AWS error (treated as "cert
// isn't ready"), or when no candidate carries our tag and no prior
// output points at a matching cert.
function readTaggedCertStatus(opts: {
  certRegion: string;
  stackRegion: string;
  domain: string;
  stackName: string;
}): string {
  const { certRegion, stackRegion, domain, stackName } = opts;
  const sh = (cmd: string): string =>
    execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  // Phase 1: by-tag lookup.
  try {
    const candidateArns = sh(
      `aws acm list-certificates --region ${certRegion} --query "CertificateSummaryList[?DomainName=='${domain}'].CertificateArn" --output text`,
    )
      .split(/\s+/)
      .filter(Boolean);
    for (const arn of candidateArns) {
      const tagMatchCount = sh(
        `aws acm list-tags-for-certificate --region ${certRegion} --certificate-arn ${arn} --query "Tags[?Key=='hereya:stackName' && Value=='${stackName}'] | length(@)" --output text`,
      );
      if (tagMatchCount === '1') {
        const status = sh(
          `aws acm describe-certificate --region ${certRegion} --certificate-arn ${arn} --query Certificate.Status --output text`,
        );
        return status || 'NOT_FOUND';
      }
    }
  } catch {
    /* fall through to phase 2 */
  }

  // Phase 2: backward-compat fallback via prior stack output.
  try {
    const prevArn = sh(
      `aws cloudformation describe-stacks --region ${stackRegion} --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='certificateArn'].OutputValue | [0]" --output text`,
    );
    if (prevArn && prevArn !== 'None' && prevArn.startsWith('arn:')) {
      const describeOut = sh(
        `aws acm describe-certificate --region ${certRegion} --certificate-arn ${prevArn} --query "Certificate.[DomainName,Status]" --output text`,
      );
      // describe-certificate --output text gives tab-separated
      // values; split on whitespace tolerates both.
      const [certDomain, certStatus] = describeOut.split(/\s+/);
      if (certDomain === domain && certStatus) {
        return certStatus;
      }
    }
  } catch {
    /* nothing more to try */
  }

  return 'NOT_FOUND';
}

/**
 * Namespace PREFIX every `logAlarms` entry publishes under; the stack name is
 * appended, giving `Hereya/AppLogs/<stackName>`.
 *
 * The shared prefix keeps "which of my apps is writing a line it shouldn't" a
 * single place to look in the CloudWatch namespace list, while the stack
 * suffix keeps two consumers that chose the same metric id from adding their
 * counts together. Dimensions would have been the natural way to say this and
 * are not available here — see the comment at the MetricFilter.
 */
const LOG_ALARM_NAMESPACE = 'Hereya/AppLogs';

interface LogAlarmSpec {
  id: string;
  pattern: string;
  description: string;
  threshold: number;
  periodMinutes: number;
}

/**
 * `logAlarms` (a JSON array in a YAML var) → validated specs.
 *
 * EVERY failure here THROWS, and that is the whole design. The failure mode
 * this feature exists to prevent is a component that fails quietly; shipping
 * it with a parser that skips a malformed entry would reproduce that failure
 * one level up — a green deploy, an alarm that was never created, and a
 * consumer who believes they are being watched. A typo must stop the deploy.
 *
 * `id` is doubly load-bearing: it is the CloudWatch metric name AND part of
 * the CDK construct id, so it is held to the alphanumeric shape both accept.
 */
function parseLogAlarms(raw: string | undefined): LogAlarmSpec[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `logAlarms is not valid JSON: ${err instanceof Error ? err.message : err}. ` +
        `Expected an array like [{"id":"…","pattern":"…","description":"…"}].`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`logAlarms must be a JSON ARRAY, got ${typeof parsed}.`);
  }

  const seen = new Set<string>();
  return parsed.map((entry, i) => {
    const where = `logAlarms[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} must be an object.`);
    }
    const { id, pattern, description, threshold, periodMinutes } =
      entry as Record<string, unknown>;

    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]{2,63}$/.test(id)) {
      throw new Error(
        `${where}.id must be 3-64 alphanumeric characters starting with a ` +
          `letter (it becomes a CloudWatch metric name and a CDK construct ` +
          `id); got ${JSON.stringify(id)}.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `${where}.id "${id}" is used twice — two alarms would collide on one ` +
          `metric and one construct id.`,
      );
    }
    seen.add(id);

    if (typeof pattern !== 'string' || pattern.trim() === '') {
      throw new Error(
        `${where}.pattern must be a non-empty CloudWatch filter pattern. An ` +
          `empty pattern matches EVERY line, which would alarm on the first ` +
          `request.`,
      );
    }
    // A description is not decoration: it is the entire message the person
    // woken at 3am receives. An alarm that only quotes its own filter pattern
    // tells them what matched, never why they should care.
    if (typeof description !== 'string' || description.trim().length < 10) {
      throw new Error(
        `${where}.description must say, in a sentence, what it means when ` +
          `this fires — it is what the alert says out loud.`,
      );
    }

    const resolvedThreshold = threshold === undefined ? 1 : threshold;
    if (
      typeof resolvedThreshold !== 'number' ||
      !Number.isInteger(resolvedThreshold) ||
      resolvedThreshold < 1
    ) {
      throw new Error(
        `${where}.threshold must be an integer >= 1; got ${JSON.stringify(threshold)}.`,
      );
    }

    const resolvedPeriod = periodMinutes === undefined ? 5 : periodMinutes;
    if (
      typeof resolvedPeriod !== 'number' ||
      !Number.isInteger(resolvedPeriod) ||
      resolvedPeriod < 1 ||
      resolvedPeriod > 1440
    ) {
      throw new Error(
        `${where}.periodMinutes must be an integer between 1 and 1440; got ` +
          `${JSON.stringify(periodMinutes)}.`,
      );
    }

    return {
      id,
      pattern: pattern.trim(),
      description: description.trim(),
      threshold: resolvedThreshold,
      periodMinutes: resolvedPeriod,
    };
  });
}

/**
 * `accessLogRetentionDays` → a CloudWatch `RetentionDays`.
 *
 * CloudWatch accepts only a fixed set of retention values, and the enum's
 * members ARE those day counts — so a plain cast would compile happily and be
 * refused by CloudFormation halfway through a deploy, with a message that names
 * neither this parameter nor the value that caused it. Validating here turns
 * that into a synth-time error naming both.
 */
function retentionFromDays(days: number): logs.RetentionDays {
  const allowed = Object.values(logs.RetentionDays).filter(
    (v): v is number => typeof v === 'number',
  );
  if (!allowed.includes(days)) {
    throw new Error(
      `accessLogRetentionDays=${days} is not a retention CloudWatch accepts. ` +
        `Pick one of: ${allowed.sort((a, b) => a - b).join(', ')}.`,
    );
  }
  return days as logs.RetentionDays;
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
