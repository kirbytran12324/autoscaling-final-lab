'use strict';
const {timingSafeEqual} = require('node:crypto');
const {ControlError} = require('./errors');

function readAuthConfig(env) {
  const required = name => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const mode = required('CONTROL_AUTH_MODE');
  if (mode === 'bearer') {
    const token = required('CONTROL_OPERATOR_TOKEN');
    if (token.length < 32) throw new Error('CONTROL_OPERATOR_TOKEN must have at least 32 characters');
    return {mode, token};
  }
  if (mode !== 'alb') throw new Error('CONTROL_AUTH_MODE must be bearer or alb');
  const albArn = required('CONTROL_ALB_ARN');
  // This application supports the documented commercial AWS endpoint only.
  const arn = /^arn:aws:elasticloadbalancing:([a-z]{2}-[a-z]+-\d):\d{12}:loadbalancer\/app\/[A-Za-z0-9-]+\/[a-f0-9]{16}$/.exec(albArn);
  if (!arn || arn[1].startsWith('cn-')) throw new Error('CONTROL_ALB_ARN must be a commercial AWS ALB ARN');
  const issuer = required('CONTROL_COGNITO_ISSUER');
  const issuerPrefix = `https://cognito-idp.${arn[1]}.amazonaws.com/${arn[1]}_`;
  if (!issuer.startsWith(issuerPrefix) || !/^[A-Za-z0-9]+$/.test(issuer.slice(issuerPrefix.length))) {
    throw new Error('CONTROL_COGNITO_ISSUER must identify a Cognito pool in the ALB region');
  }
  const clientId = required('CONTROL_COGNITO_CLIENT_ID');
  if (!/^[a-zA-Z0-9]{1,128}$/.test(clientId)) throw new Error('CONTROL_COGNITO_CLIENT_ID is invalid');
  const subjects = required('CONTROL_OPERATOR_SUBJECTS').split(',').map(value => value.trim());
  if (subjects.some(value => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))) {
    throw new Error('CONTROL_OPERATOR_SUBJECTS must contain Cognito subject UUIDs');
  }
  const httpsOrigin = name => {
    const value = required(name);
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
      throw new Error(`${name} must be an exact HTTPS origin without a trailing slash`);
    }
    return value;
  };
  const publicOrigin = httpsOrigin('CONTROL_PUBLIC_ORIGIN');
  const cognitoOrigin = httpsOrigin('CONTROL_COGNITO_DOMAIN');
  const cookieName = env.CONTROL_ALB_COOKIE_NAME || 'AWSELBAuthSessionCookie';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(cookieName)) throw new Error('CONTROL_ALB_COOKIE_NAME is invalid');
  const logoutUrl = new URL('/logout', cognitoOrigin);
  logoutUrl.searchParams.set('client_id', clientId);
  logoutUrl.searchParams.set('logout_uri', `${publicOrigin}/`);
  return {mode, albArn, issuer, clientId, subjects, publicOrigin, cookieName,
    logoutUrl: logoutUrl.href, jwksUri: `https://public-keys.auth.elb.${arn[1]}.amazonaws.com`};
}

function createAlbVerifier(config, dependencies) {
  const {AlbJwtVerifier} = require('aws-jwt-verify');
  // The library's generic issuer check uses payload.iss. ALB puts iss in its
  // signed header instead: enforce that exact value in customJwtCheck below.
  return AlbJwtVerifier.create({albArn: config.albArn, issuer: null,
    clientId: config.clientId, jwksUri: config.jwksUri, graceSeconds: 0,
    customJwtCheck: ({header}) => {
      // ALB expiry is in the signed header, not necessarily in the payload.
      const expiry = typeof header.exp === 'number' ? header.exp :
        typeof header.exp === 'string' && /^\d+$/.test(header.exp) ? Number(header.exp) : NaN;
      if (header.alg !== 'ES256' || header.iss !== config.issuer || !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000) {
        throw new Error('Invalid ALB algorithm or lifetime');
      }
    }}, dependencies);
}

function createAuthenticator(config, verifier) {
  if (config.mode === 'bearer') {
    if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('Invalid bearer configuration');
    const expected = Buffer.from(`Bearer ${config.token}`);
    return async request => {
      const actual = Buffer.from(request.headers.authorization || '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new ControlError(401, 'UNAUTHORIZED', 'Enter a valid operator token.');
      }
      return {mode: 'bearer', operator: true};
    };
  }
  if (config.mode !== 'alb' || !config.albArn || !config.issuer || !config.clientId ||
      !config.publicOrigin || !config.subjects?.length || !config.jwksUri || !config.logoutUrl || !config.cookieName) {
    throw new Error('Invalid ALB configuration');
  }
  const trustedVerifier = verifier || createAlbVerifier(config);
  const operators = new Set(config.subjects);
  return async request => {
    const token = request.headers['x-amzn-oidc-data'];
    if (typeof token !== 'string' || token.length > 24000) throw new ControlError(401, 'UNAUTHORIZED', 'Sign in to use operator controls.');
    let claims;
    try { claims = await trustedVerifier.verify(token); }
    catch (error) {
      // Network errors are service failures; cryptographic/claim failures are 401.
      if (['FetchError', 'NonRetryableFetchError', 'WaitPeriodNotYetEndedJwkError'].includes(error.constructor?.name)) {
        throw new ControlError(503, 'IDENTITY_UNAVAILABLE', 'Identity verification is temporarily unavailable.');
      }
      throw new ControlError(401, 'UNAUTHORIZED', 'Your session is missing or expired. Sign in again.');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) throw new ControlError(401, 'UNAUTHORIZED', 'Identity has no subject.');
    if (!operators.has(claims.sub)) throw new ControlError(403, 'FORBIDDEN', 'This account is not an approved operator.');
    return {mode: 'alb', subject: claims.sub, operator: true};
  };
}

function checkBrowserRequest(request, config) {
  if (config.mode === 'alb') {
    if (['GET', 'HEAD'].includes(request.method)) return;
    if (request.headers.origin !== config.publicOrigin || request.headers['x-control-csrf'] !== '1' ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new ControlError(403, 'CSRF_REJECTED', 'Use same-origin operator controls to make changes.');
    }
  } else if (request.headers.origin) {
    let origin;
    try { origin = new URL(request.headers.origin); } catch { /* rejected below */ }
    if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.origin !== request.headers.origin ||
        origin.host !== request.headers.host) throw new ControlError(403, 'INVALID_ORIGIN', 'Cross-origin control requests are rejected.');
  }
}

function logout(response, config) {
  response.setHeader('set-cookie', [config.cookieName, ...[0, 1, 2, 3].map(i => `${config.cookieName}-${i}`), 'AWSALBAuthNonce']
    .map(name => `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None`));
  return {logoutUrl: config.logoutUrl};
}

module.exports = {readAuthConfig, createAlbVerifier, createAuthenticator, checkBrowserRequest, logout};
