# hereya/aws-app-lambda

Single CDK stack that provisions a fullstack app's runtime + delivery on AWS:

- **API Gateway v2 (HTTP API)** with a Lambda integration (catch-all `ANY /` and `ANY /{proxy+}`)
- **Pre-bundled Node.js Lambda** (use `Code.fromAsset` on your `apps/backend/dist`)
- **S3 bucket** for built static frontend assets
- **CloudFront distribution** with two behaviors:
  - `/api/*` → API Gateway origin (`AllowedMethods.ALLOW_ALL`, `CachePolicy.CACHING_DISABLED`, origin-request forwards cookie `hereya_sid` + `Authorization` + `Content-Type`)
  - default `*` → S3 origin (cached, optional SPA fallback to `/index.html` when `isSpa=true`)
- **ACM certificate** in `us-east-1` for `domain` + `www.${domain}`. Two modes: auto-Route 53 (single deploy, `DnsValidatedCertificate` validated against the workspace's hosted zone) or external DNS (two deploys, `RequestCertificate` + `AddTagsToCertificate` + `DescribeCertificate` custom resources). The cert is tagged with `hereya:stackName=<stack>` after creation so that a tag-filtered synth-time lookup can find THIS stack's cert without colliding with unrelated certs for the same hostname elsewhere in the account. **Non-blocking** in external mode — pass 1 completes on the default `*.cloudfront.net` cert and emits the DNS records the operator must add.
- **CloudFront Function** on the default behavior: `www → apex 301` + URL rewrite (SPA or MPA).
- **Consolidated Secrets Manager secret** — every `secret://`-prefixed env var collected into one JSON secret. Lambda receives `HEREYA_SECRETS_ARN`; the Lambda is expected to read and inject those values on cold start (see template's `secrets.ts`).
- **IAM auto-attach** — any env var with key matching `iamPolicy*` / `IAM_POLICY_*` is JSON-parsed and its `Statement[]` is attached to the Lambda role.

## Inputs

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `STACK_NAME` | yes | — | CDK stack id |
| `hereyaProjectRootDir` | yes | — | Project root |
| `domain` | **yes** | — | Apex domain (e.g. `domain.xyz`) — apex + `www.${domain}` are served |
| `backendDistFolder` | no | `apps/backend/dist` | Pre-bundled Lambda code (must contain `handler.js` exporting `handler`) |
| `frontendDistFolder` | no | `apps/frontend/dist` | Built static assets |
| `lambdaHandler` | no | `handler.handler` | Handler export |
| `lambdaMemoryMb` | no | `512` | Lambda memory |
| `lambdaTimeoutSec` | no | `30` | Lambda timeout |
| `nodeRuntime` | no | `nodejs22.x` | Lambda runtime (`nodejs18.x` / `nodejs20.x` / `nodejs22.x`) |
| `isSpa` | no | `false` | SPA fallback on static origin |
| `runMigrations` | no | `true` | Create the migration Lambda + its Custom Resource |
| `migrationHandler` | no | `migrate.handler` | Migration handler export, inside the same backend bundle |
| `migrationHashFolder` | no | `drizzle` | Folder (inside the bundle) whose files decide when migrations re-run |
| `migrationHashExtensions` | no | `.sql` | Extensions counted when hashing that folder |
| `migrationTimeoutSec` | no | `300` | Migration Lambda timeout |
| `migrationMemoryMb` | no | `512` | Migration Lambda memory |
| `scheduledWakeCron` | no | — | EventBridge expression (`cron(...)` / `rate(...)`). **Absent = the whole feature is off** |
| `scheduledWakeHandler` | no | `scheduled.handler` | Handler export woken by the cron, inside the same backend bundle |
| `scheduledWakeTimeoutSec` | no | `300` | Scheduled-wake Lambda timeout |
| `scheduledWakeMemoryMb` | no | `512` | Scheduled-wake Lambda memory |

## Deploy-time migrations — when do they actually run?

The migration Lambda is invoked by a CloudFormation Custom Resource, and a
Custom Resource only fires when **one of its properties changes**. That property
is a hash, computed at synth time from two inputs:

1. the **migration folder** (`migrationHashFolder`, `.sql` by default), and
2. the **compiled migration handler** itself (`migrate.js` & co).

**The second input landed in 0.5.4, and it is a fix, not a refinement.** Before
that, only the folder was hashed — so a project whose migrations are *code*
rather than `.sql` files (one-shot functions gated by a sentinel row, the usual
shape for a key/value store) hashed a folder that did not exist, got the
constant `no-migrations`, and its Custom Resource fired **exactly once, at stack
creation**. The handler was redeployed on every deploy thereafter and never
invoked again. Migrations shipped, were believed applied, and did nothing —
silently, because nothing errors in that state.

Practical consequences:

- **Upgrading to 0.5.4 changes the hash for every existing stack**, so the
  Custom Resource fires once on the next deploy. That is the intended healing
  step. Your migration runner must be idempotent — Drizzle's is, and the
  sentinel pattern is by construction.
- Afterwards, migrations re-run whenever the backend bundle's migration handler
  changes, which is precisely when you have added one.
- The cost of a redundant fire is one Lambda invocation that no-ops. Nothing is
  replaced or recreated: the Custom Resource gates the app Lambda's rollout, it
  does not rebuild it.
- Set `runMigrations=false` if your backend has no database at all.

## Scheduled wake — doing something because TIME passed

Some work isn't triggered by a request: a reminder before a deadline, a notice
before a retention cut-off, any periodic sweep. Set `scheduledWakeCron` and the
stack adds an EventBridge rule that invokes a **dedicated handler out of the
same backend bundle** (default export `scheduled.handler`).

```yaml
# hereyaconfig/hereyavars/hereya-aws-app-lambda.yaml
scheduledWakeCron: cron(0 * * * ? *)   # every hour, on the hour (UTC)
```

- **Entirely opt-in.** No `scheduledWakeCron` → no rule, no Lambda, no
  permission, nothing added. An app that says nothing about schedules
  synthesizes a byte-for-byte identical template to before this feature
  existed.
- **A separate function, not a cron on the app handler.** The app handler is an
  HTTP adapter; feeding it an EventBridge event would make every app grow a
  shape-sniffing branch at its front door, where getting it wrong breaks the
  website rather than the cron. Your app learns "I was woken by the clock, not
  by a request" from *which entry point ran*.
- Same environment, secrets (`HEREYA_SECRETS_ARN`) and IAM as the app Lambda,
  and it waits for deploy-time migrations exactly like the app does.
- Retries twice, then stops (`maxEventAge` 30 min). The default EventBridge
  policy — 185 retries over 24 h — would only pile duplicate work onto an app
  already having a bad day.

⚠️ **Your handler must be idempotent.** EventBridge delivers at least once and
retries on failure, so a sweep that acts *per run* rather than *per due item*
will eventually act twice — which, for anything that emails a customer or
deletes data, is the way this feature does real harm. Mark each item done as
you handle it, and make re-running a no-op.

## Outputs

| Output | Description |
|--------|-------------|
| `cloudfrontUrl` | Distribution default URL (works on first deploy, before DNS) |
| `appUrl` | `https://${domain}` (canonical, active once aliases are attached) |
| `apiUrl` | `${appUrl}/api` |
| `certificateArn` | ACM certificate ARN (us-east-1) |
| `certificateStatus` | `PENDING_VALIDATION` or `ISSUED` |
| `dnsRecordCertValidationApex{Name,Type,Value}` | ACM validation CNAME for apex |
| `dnsRecordCertValidationWww{Name,Type,Value}` | ACM validation CNAME for www |
| `dnsRecordCloudfrontApex{Name,Type,Value}` | CNAME (or ALIAS) record at apex → CloudFront |
| `dnsRecordCloudfrontWww{Name,Type,Value}` | CNAME `www.${domain}` → CloudFront |
| `dnsRecordsToAdd` | Aggregated JSON array of all records |
| `scheduledWakeFunctionName` | Lambda invoked on the cron (only when `scheduledWakeCron` is set) |

## Two-deploy ACM flow (external DNS)

1. **First `hereya deploy`** — `RequestCertCr` creates the cert (status `PENDING_VALIDATION`); `TagCertCr` stamps it with `Tags=[{hereya:stackName=<stack>}]`; `DescribeCertCr` polls until both apex + www `DomainValidationOptions` are populated and emits them as flat top-level attributes. The synth-time lookup finds no tagged cert yet, so the distribution comes up at `https://dxxxx.cloudfront.net` on the default `*.cloudfront.net` cert with no Aliases. Every DNS record the operator must add (cert validation CNAMEs + CloudFront apex/www CNAMEs) is emitted as a stack output.
2. Operator adds the records in their external DNS provider. ACM validates the cert (~5–30 min).
3. **Second `hereya deploy`** — synth-time `aws acm list-certificates` + `list-tags-for-certificate` + `describe-certificate` pipeline finds this stack's tagged cert in `ISSUED` status. The L2 Distribution gets `domainNames: [domain, www.${domain}]` and `certificate: <ARN>` props; CFn updates ViewerCertificate + Aliases in one deploy. CloudFront propagates (~5–15 min). The app is now live at `https://${domain}`.

> The lookup filters on **this stack's** tag (`hereya:stackName=<stack>`), not just `DomainName`, so a stale ACM cert for the same hostname elsewhere in the account (e.g. from a previously hand-rolled CloudFront) cannot trick the gate into reporting ISSUED and attaching this stack's freshly-requested PENDING cert. Fixed in `0.5.3`.

> **Why not a deploy-time CFn Condition keyed on `DescribeCertCr.Status`?** CloudFormation evaluates Conditions before resource creation, so a Condition referencing a resource attribute fails with `Unresolved dependencies [DescribeCertCr]`. v0.5.0 tried this and had to be reverted (commit a7125e4); v0.5.3 keeps the synth-time gate from v0.5.1 but scopes the lookup by tag.

> **Upgrading from `<0.5.3`.** Transparent. `RequestCertCr`'s Properties are byte-identical to <0.5.3 (same domain + SANs + IdempotencyToken hash), so CFn does not fire the CR's Update event and ACM does not mint a new cert — the existing cert stays. The new `TagCertCr` resource Creates on first 0.5.3 deploy and tags the existing cert. On that first deploy the synth-time lookup hits a fallback: it queries CloudFormation for the stack's prior `certificateArn` output, uses that ARN's live Status, and aliases stay attached for the whole upgrade. Subsequent deploys use the by-tag fast path.

## Secret-injection pattern

This package collects every `secret://`-prefixed env value into a **single** consolidated Secrets Manager secret (one resource, one IAM grant, one cold-start `GetSecretValue` call in the Lambda). The Lambda receives `HEREYA_SECRETS_ARN`; it is responsible for fetching and merging the values into `process.env` on cold start. See `hereya-fullstack-serverless-template/apps/backend/src/secrets.ts` for the canonical loader.

This intentionally differs from `aws-mcp-lambda`, which creates one secret per env var.
