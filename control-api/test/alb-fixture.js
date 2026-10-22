'use strict';
// Synthetic keys and identities only. No production environment switch loads
// these fixtures; callers inject the verifier through the application factory.
const {generateKeyPairSync, sign} = require('node:crypto');
const {AlbJwksCache} = require('aws-jwt-verify/alb-cache');
const {readAuthConfig, createAlbVerifier} = require('../src/auth');
const operator = '11111111-1111-4111-8111-111111111111';
const environment = {CONTROL_AUTH_MODE: 'alb',
  CONTROL_ALB_ARN: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/lab/0123456789abcdef',
  CONTROL_COGNITO_ISSUER: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_Pool',
  CONTROL_COGNITO_CLIENT_ID: 'client123', CONTROL_OPERATOR_SUBJECTS: operator,
  CONTROL_PUBLIC_ORIGIN: 'https://lab.example', CONTROL_COGNITO_DOMAIN: 'https://lab.auth.ap-southeast-1.amazoncognito.com'};
const auth = readAuthConfig(environment);
const kid = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('ec', {namedCurve: 'P-256'});
function signed(header = {}, payload = {sub: operator}, key = keys.privateKey, padded = false) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString(padded ? 'base64' : 'base64url').replace(/\+/g, '-').replace(/\//g, '_');
  const input = `${encode({alg: 'ES256', kid, signer: auth.albArn, iss: auth.issuer,
    client: auth.clientId, exp: Math.floor(Date.now() / 1000) + 600, ...header})}.${encode(payload)}`;
  return `${input}.${sign('sha256', Buffer.from(input), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url')}`;
}
function verifier(fetcher) {
  const cache = new AlbJwksCache(fetcher ? {fetcher} : undefined);
  if (!fetcher) cache.addJwks(auth.jwksUri, {keys: [{...keys.publicKey.export({format: 'jwk'}), kid, alg: 'ES256', use: 'sig'}]});
  return createAlbVerifier(auth, {jwksCache: cache});
}
module.exports = {auth, environment, operator, kid, keys, signed, verifier};
