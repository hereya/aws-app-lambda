# hereya/aws-app-lambda

Single CDK stack that provisions a fullstack app's runtime + delivery on AWS:

- **API Gateway v2 (HTTP API)** with a Lambda integration (catch-all `ANY /` and `ANY /{proxy+}`)
- **Pre-bundled Node.js Lambda** (use `Code.fromAsset` on your `apps/backend/dist`)
- **S3 bucket** for built static frontend assets
- **CloudFront distribution** with two behaviors:
  - `/api/*` → API Gateway origin (`AllowedMethods.ALLOW_ALL`, `CachePolicy.CACHING_DISABLED`, origin-request forwards cookie `hereya_sid` + `Authorization` + `Content-Type`)
  - default `*` → S3 origin (cached, optional SPA fallback to `/index.html` when `isSpa=true`)
- **ACM certificate** in `us-east-1` for `domain` + `www.${domain}`, provisioned via three chained `cr.AwsCustomResource` calls (RequestCertificate → DescribeCertificate → PutParameter on `/hereya/${stackName}/certStatus`). **Non-blocking** — the deploy completes before the cert is validated.
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

## Two-deploy ACM flow

1. **First `hereya deploy`** — Stack creates the cert (status `PENDING_VALIDATION`), brings up the distribution at `https://dxxxx.cloudfront.net` (no aliases), and outputs every DNS record the user must add (cert validation CNAMEs + CloudFront apex/www CNAMEs).
2. User adds the records in their external DNS provider. ACM validates the cert (~5–30 min).
3. **Second `hereya deploy`** — Synth-time `ssm.StringParameter.valueFromLookup('/hereya/<stack>/certStatus')` reads `ISSUED`, so the distribution is reconfigured with `domainNames: [domain, www.${domain}]` and the cert is attached. CloudFront propagates (~5–15 min). The app is now live at `https://${domain}`.

## Secret-injection pattern

This package collects every `secret://`-prefixed env value into a **single** consolidated Secrets Manager secret (one resource, one IAM grant, one cold-start `GetSecretValue` call in the Lambda). The Lambda receives `HEREYA_SECRETS_ARN`; it is responsible for fetching and merging the values into `process.env` on cold start. See `hereya-fullstack-serverless-template/apps/backend/src/secrets.ts` for the canonical loader.

This intentionally differs from `aws-mcp-lambda`, which creates one secret per env var.
