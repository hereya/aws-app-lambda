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
