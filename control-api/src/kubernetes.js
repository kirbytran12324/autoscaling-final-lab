'use strict';
const https = require('node:https');
const {readFile} = require('node:fs/promises');
const {ControlError} = require('./errors');
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LIST_PAGE_SIZE = 100;

class KubernetesClient {
  constructor(namespace, {host = process.env.KUBERNETES_SERVICE_HOST,
    port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443', credentialRoot = SERVICE_ACCOUNT,
    requestImpl = https.request, readFileImpl = readFile} = {}) {
    if (!host || !/^\d+$/.test(String(port))) throw new Error('Kubernetes service connection is required');
    Object.assign(this, {namespace, host, port, credentialRoot, requestImpl, readFileImpl});
  }
  async request(method, path, body, {text = false, optional = false} = {}) {
    const [token, ca] = await Promise.all([this.readFileImpl(`${this.credentialRoot}/token`, 'utf8'),
      this.readFileImpl(`${this.credentialRoot}/ca.crt`)]);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = this.requestImpl({hostname: this.host, port: this.port, path, method, ca,
        headers: {authorization: `Bearer ${token.trim()}`, accept: 'application/json',
          ...(payload ? {'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json'} : {})}}, response => {
        const chunks = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            const error = Object.assign(new Error('Kubernetes response exceeds limit'), {code: 'KUBE_RESPONSE_TOO_LARGE'});
            reject(error);
            request.destroy(error);
          } else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (optional && response.statusCode === 404) return resolve(null);
          if (response.statusCode >= 400) return reject(new ControlError(
            response.statusCode === 409 ? 409 : 503,
            response.statusCode === 409 ? 'KUBE_CONFLICT' : 'KUBERNETES_UNAVAILABLE',
            response.statusCode === 403 ? 'Control service lacks required Kubernetes permissions.' : 'Kubernetes operation failed.'));
          const value = Buffer.concat(chunks).toString('utf8');
          try { resolve(text ? value : JSON.parse(value || '{}')); } catch (error) { reject(error); }
        });
      });
      request.setTimeout(10000, () => request.destroy(new Error('Kubernetes request timed out')));
      request.on('error', reject);
      request.end(payload);
    });
  }
  path(kind, name = '') {
    const api = kind === 'jobs' ? '/apis/batch/v1' : '/api/v1';
    return `${api}/namespaces/${encodeURIComponent(this.namespace)}/${kind}${name ? '/' + encodeURIComponent(name) : ''}`;
  }
  get(kind, name) { return this.request('GET', this.path(kind, name), undefined, {optional: true}); }
  async list(kind, selector) {
    let limit = LIST_PAGE_SIZE;
    for (;;) {
      const items = [], tokens = new Set();
      let first, continuation = '';
      try {
        do {
          const query = new URLSearchParams({labelSelector: selector, limit: String(limit)});
          if (continuation) query.set('continue', continuation);
          const page = await this.request('GET', `${this.path(kind)}?${query}`);
          if (!Array.isArray(page.items) || (page.metadata?.continue && typeof page.metadata.continue !== 'string')) {
            throw new Error('Kubernetes returned an invalid list');
          }
          first ||= page;
          items.push(...page.items);
          continuation = page.metadata?.continue || '';
          if (continuation && tokens.has(continuation)) throw new Error('Kubernetes repeated a continuation token');
          tokens.add(continuation);
        } while (continuation);
        const metadata = {...first.metadata, continue: ''};
        delete metadata.remainingItemCount;
        return {...first, metadata, items};
      } catch (error) {
        if (error.code !== 'KUBE_RESPONSE_TOO_LARGE' || limit === 1) throw error;
        // A count limit alone does not bound log-heavy ConfigMap pages. Restart
        // the whole snapshot with smaller pages rather than mixing snapshots.
        limit = Math.max(1, Math.floor(limit / 2));
      }
    }
  }
  create(kind, body) { return this.request('POST', this.path(kind), body); }
  replace(kind, name, body) { return this.request('PUT', this.path(kind, name), body); }
  patch(kind, name, body) { return this.request('PATCH', this.path(kind, name), body); }
  delete(kind, name, metadata) {
    return this.request('DELETE', this.path(kind, name), {apiVersion: 'v1', kind: 'DeleteOptions',
      propagationPolicy: 'Foreground', preconditions: {uid: metadata.uid, resourceVersion: metadata.resourceVersion}}, {optional: true});
  }
  logs(name) {
    return this.request('GET', `${this.path('pods', name)}/log?tailLines=100&limitBytes=65536&timestamps=true`, undefined, {text: true});
  }
}
module.exports = {KubernetesClient};
