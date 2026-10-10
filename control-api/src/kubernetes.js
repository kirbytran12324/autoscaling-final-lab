'use strict';
const https = require('node:https');
const {readFile} = require('node:fs/promises');
const {ControlError} = require('./errors');
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount';

class KubernetesClient {
  constructor(namespace, {host = process.env.KUBERNETES_SERVICE_HOST,
    port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443', credentialRoot = SERVICE_ACCOUNT} = {}) {
    if (!host || !/^\d+$/.test(String(port))) throw new Error('Kubernetes service connection is required');
    Object.assign(this, {namespace, host, port, credentialRoot});
  }
  async request(method, path, body, {text = false, optional = false} = {}) {
    const [token, ca] = await Promise.all([readFile(`${this.credentialRoot}/token`, 'utf8'),
      readFile(`${this.credentialRoot}/ca.crt`)]);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = https.request({hostname: this.host, port: this.port, path, method, ca,
        headers: {authorization: `Bearer ${token.trim()}`, accept: 'application/json',
          ...(payload ? {'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json'} : {})}}, response => {
        let value = '', size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) request.destroy(new Error('Kubernetes response exceeds limit'));
          else value += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          if (optional && response.statusCode === 404) return resolve(null);
          if (response.statusCode >= 400) return reject(new ControlError(
            response.statusCode === 409 ? 409 : 503,
            response.statusCode === 409 ? 'KUBE_CONFLICT' : 'KUBERNETES_UNAVAILABLE',
            response.statusCode === 403 ? 'Control service lacks required Kubernetes permissions.' : 'Kubernetes operation failed.'));
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
  list(kind, selector) { return this.request('GET', `${this.path(kind)}?labelSelector=${encodeURIComponent(selector)}`); }
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
