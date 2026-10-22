# Operator authentication contract

Completed archives (`/`, `/runs/*`, `/api/runs/*`) and replay assets remain public.
Operator pages are `/operate`, `/operate/`, and `/operate/*`, including
`/operate/runs/:id`. Enter them with full browser navigation. Every
`/api/control` and `/api/control/*` request requires authentication and operator
authorization, including unknown paths and methods. Health responses contain
only status. Deployment and login never submit tournament creation.

The server explicitly selects `CONTROL_AUTH_MODE=bearer` for local development
or `alb` for AWS. There is no fallback between modes. ALB mode verifies signed
claims, then permits only configured subject IDs. `GET /api/control/session`
returns mode, subject, operator=true, and maxConcurrency with no-store caching.
Missing/invalid/expired identity returns 401; verified non-operators return 403;
key/service failures return 503. API requests never redirect to login. The UI
offers explicit sign-in after 401, access-denied after 403, and retry for service
unavailability. It never retries a mutation automatically. Nonsecret unfinished
form fields may survive navigation in sessionStorage; credentials never do.

ALB mutations require an exact configured HTTPS Origin and `X-Control-CSRF: 1`.
No CORS access is granted. Logout is `POST /auth/logout`, with the same CSRF
checks but no identity requirement so expired/forbidden users can sign out.
It expires the configured ALB cookie and all four shards, then returns a fixed
Cognito logout URL. The browser navigates there; the public landing page is `/`.
Clearing React state is only a local bearer-mode lock, never managed logout.

## Server and browser configuration

All existing runner, status, storage, version and namespace configuration remains
required. `RUNNER_STATUS_TOKEN` remains a separate internal service credential;
it is unrelated to Cognito. The Kubernetes ServiceAccount and namespace RBAC
continue to manage Jobs. Cognito users are application users, separate from IAM.

| Variable | Contract |
| --- | --- |
| `CONTROL_AUTH_MODE` | Required, exactly `bearer` or `alb`; invalid/missing values abort startup |
| `CONTROL_OPERATOR_TOKEN` | Bearer mode only; at least 32 characters and distinct from runner status token |
| `CONTROL_ALB_ARN` | ALB mode: exact commercial `arn:aws:elasticloadbalancing:REGION:ACCOUNT:loadbalancer/app/NAME/ID` |
| `CONTROL_COGNITO_ISSUER` | ALB mode: `https://cognito-idp.REGION.amazonaws.com/REGION_POOL`; same region as ALB |
| `CONTROL_COGNITO_CLIENT_ID` | ALB mode: exact confidential ALB app client ID |
| `CONTROL_OPERATOR_SUBJECTS` | ALB mode: nonempty comma-separated Cognito `sub` UUID allowlist |
| `CONTROL_PUBLIC_ORIGIN` | ALB mode: exact canonical HTTPS origin, including a nonstandard port if used; no slash/path |
| `CONTROL_COGNITO_DOMAIN` | ALB mode: trusted configured HTTPS managed-login domain origin, no trailing slash |
| `CONTROL_ALB_COOKIE_NAME` | ALB mode: same cookie name as listener; default `AWSELBAuthSessionCookie` |

ALB mode does not read `CONTROL_OPERATOR_TOKEN`. Supplying it does not enable
fallback. Missing identity is rejected even if a correct bearer token or unsigned
`x-amzn-oidc-identity` is present. Government and China partitions are deliberately
unsupported until their key endpoints and issuer configuration are validated.

Set browser runtime `controlEnabled: true, controlAuthMode: 'alb'` for AWS. Local
mode uses `controlAuthMode: 'bearer'` (also the backward-compatible browser default).
This is public mode selection only: never include tokens, client secrets, or keys.
A mode mismatch cannot grant access; managed UI rejects a bearer session response.

`aws-jwt-verify` 5.2.1 performs signature verification with ALB ES256 public keys,
signer ARN and client checks. The application additionally requires the exact
signed-header issuer and a nonexpired integer Unix timestamp in signed-header
`exp` (numeric strings also accepted). ALB claims need not have payload `iss` or
`exp`: the library's general payload-issuer check is disabled specifically because
the mandatory signed-header issuer check replaces it. Standard payload lifetime
checks, when present, still apply. Authorization uses only verified payload `sub`;
group claims, email and unsigned identity headers never grant access.

Key lookup uses `https://public-keys.auth.elb.REGION.amazonaws.com/UUID`, deriving
the region from the trusted ARN. The library validates UUID key IDs, caches keys,
and ignores request-supplied `jku`/`x5u` locations. There is no environment option
for arbitrary key URLs or bypassing verification. Verifier dependency injection
is an application-factory testing seam; production startup always creates the
real verifier. Errors/logs contain safe codes, never the raw identity or credentials.

## Nginx and the trusted proxy boundary

Mount `explorer-web/control-proxy.conf` only when the control Service exists. It
proxies `/api/control`, `/api/control/*` and exact `/auth/logout`. It explicitly
forwards signed data, browser Host including port, the original URI and the
ALB-supplied single HTTP(S) scheme. It overwrites original-request metadata rather
than appending caller chains, and removes unsigned legacy identity/access-token
headers. The API's ALB CSRF check uses the configured origin, never a caller's
Host or forwarded scheme. `X-Original-URI` is diagnostic metadata, not authorization.

This file does not authenticate page requests. AWS must ensure **only the ALB**
can reach web targets, and **only web Pods** can reach the control Service. Keep
control/status Services private, with security groups and NetworkPolicies blocking
direct public targets, NodePorts and ingress paths around the authentication rules.
ALB must replace incoming identity headers on authenticated forwarding. Signed
claims are bearer evidence until expiry; backend isolation is still mandatory.
Current Nginx listens on HTTP 8080 inside the private network; target encryption
would require a separately configured HTTPS target listener and certificate.

ALB cookie mutations, including logout, require exact `Origin` (scheme/host/port),
`X-Control-CSRF: 1`, and, if supplied, `Sec-Fetch-Site: same-origin`. Requests with
missing Origin are rejected. The custom header requires a browser CORS preflight
for cross-origin use, which the API does not authorize. A static custom header is
intentional: it is a CSRF signal, not a credential or secret. No mutation happens
on GET. The existing POST rate limit remains 20/minute per connection address
(shared behind the proxy); JSON creation bodies remain capped at 4 KiB.

## Terraform handoff (no infrastructure changed here)

1. Create a Cognito **Essentials** user pool with self-registration disabled
   (`AllowAdminCreateUserOnly=true`), MFA required, and software-token/TOTP MFA
   enabled. Administrators create operator accounts and complete required password
   changes/MFA enrollment. Add their immutable `sub` values to the server allowlist.
   ALB does not enforce that allowlist or Cognito group membership.
2. Configure a managed-login domain/branding version 2 and a **confidential app
   client with a generated secret**, authorization-code flow, `openid` scope and
   Cognito provider. The ALB uses this client; React does not implement OAuth or
   receive the client secret. Register exact lowercase
   `https://HOST/oauth2/idpresponse` callback and `https://HOST/` sign-out URL.
   Include any intentionally supported canonical hostname explicitly.
3. Configure an HTTPS ALB listener, canonical host condition and certificate.
   Redirect HTTP to HTTPS. Default unexpected hosts to a fixed rejection, with no
   alternate forwarding listener. Configure `authenticate-cognito` with the pool
   ARN, client ID and domain above, same configured cookie name and a deliberately
   bounded session timeout. Use short reasonable access-token lifetime to bound
   copied-cookie/token reuse; logout clears browser cookies and the Cognito login
   session, but is not global token revocation or administrative sign-out.
4. Before public fallback rules, protect these case-sensitive path patterns:

   | Priority | Path conditions | Action before forwarding to web |
   | --- | --- | --- |
   | Highest control API | `/api/control*` | authenticate-cognito, `OnUnauthenticatedRequest=deny` (401) |
   | Operator pages/progress | `/operate*` | authenticate-cognito, `OnUnauthenticatedRequest=authenticate` (login redirect) |
   | Public logout | exact `/auth/logout` | Forward without authentication; application enforces POST/CSRF |
   | Public archives/assets | Remaining canonical public paths | Forward without authentication |

   The broad suffix patterns deliberately cover `/operate`, `/operate/`, progress
   descendants, near-prefix variants, `/api/control`, trailing slashes and all API
   descendants/methods. The application only executes canonical lowercase control
   paths, rejecting encoded paths, repeated slashes, trailing API slashes and dot
   segments after authentication. Do not add aliases or rewrites into control
   routes. Deny ambiguous/encoded separator and dot-segment requests at the edge
   if URL normalization could rewrite them into protected paths. Verify the actual
   ALB normalization/rule behavior during integration; application verification
   remains mandatory even when listener matching misses a malformed path.
5. Supply the server variables above and the existing runner configuration,
   enable the web proxy/runtime mode, preserve archive-only explorer and replay
   storage, and restrict target/network access. Permit API HTTPS egress to the
   configured regional AWS public-key endpoint; ALB needs Cognito endpoint access.
   The app needs neither an identity pool nor new IAM permissions for these users.
6. Keep health checks on the minimal health endpoints. Preserve singleton runner
   admission, persistent storage and existing namespace Job RBAC. No login,
   Deployment rollout, or health request creates a run. Any promotion must wait
   for rollout and public/protected-route smoke tests; keep persistent data out
   of rollback deletion.

## Validation and remaining integration gates

Local tests use generated P-256 keys, AWS-format signed fixtures and injected
cached keys; no fixture switch exists in production configuration. Browser checks
exercise the production build with simulated Kubernetes, including 401/403,
explicit full-navigation login, expired mutation, draft restoration, no mutation
replay, accepted-run progress, pause/resume, publication and Cognito logout
navigation. Nginx image checks verify signed-header forwarding, original HTTPS and
Host, removal of unsigned headers, CSRF rejection, and expiry of all cookie shards.

CI runs control signed-fixture tests against the packaged API and both bearer and
managed browser fixtures, plus the production web image/proxy check. No real AWS
login, MFA enrollment, ALB cookie issuance/refresh, key rotation from live AWS,
listener precedence/normalization, SG isolation, target TLS, cluster RBAC/CSI, or
deployment rollout is proved by local fixtures. Those require later provisioning
and controlled integration tests, including direct-access/bypass attempts and
logout followed by a fresh protected navigation. Do not start tournaments as
part of deployment smoke tests; use read-only session/options/health requests.

### Local verification: October 15, 2026

- Control API: 19 functional tests passed on the host and in the final Node
  24.20.0 production image (default image test discovery also counts two fixture
  modules, reporting 21 passes). Includes both startup modes, actual signatures,
  canonical-path rejection, CSRF and singleton admission/recovery.
- Frontend: 33 tests passed on the host and in Node 24/Linux. TypeScript and the
  production build passed, including the final web image's Linux build.
- Headless Edge: bearer and managed-session fixtures passed; managed mode also
  verified history navigation, draft restoration without mutation replay and
  logout navigation. Desktop/mobile checks reported no page errors.
- The final Nginx image passed read-only startup, packaged asset/player checks,
  bearer proxy checks, signed ALB forwarding, original HTTPS/Host, 401/403 and
  CSRF behavior, and cookie-shard expiry. Fixture containers/networks were removed
  by the check. Both affected images remain local and unpublished.
- 63 selected existing Linux runner recovery, graceful-stop, status and archive
  publication tests passed with networking disabled and temporary test state.
- Pinned actionlint and maintained-file size checks passed. The existing
  525-line report stylesheet remains an advisory below the 800-line ceiling.
- No Terraform, cloud resources, IAM, real user accounts, shared deployments,
  persistent data or unrelated worktree changes were modified. Full GitHub CI
  execution and the real AWS integration gates above remain unverified.

Authoritative references reviewed for this implementation:

- [ALB authentication, signed claims and logout](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
- [AWS JWT Verify ALB support](https://github.com/awslabs/aws-jwt-verify#verifying-user-claims-jwts-from-application-load-balancers)
- [Cognito logout endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/logout-endpoint.html)
