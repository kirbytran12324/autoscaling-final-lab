# Metrics Server

This directory installs [Metrics Server](https://github.com/kubernetes-sigs/metrics-server) for the Docker Desktop Kubernetes cluster used by this lab. Metrics Server exposes resource metrics through the Kubernetes Metrics API, which makes commands such as `kubectl top` work and provides metrics to the Horizontal Pod Autoscaler.

## Upstream source

- Version: [`v0.8.0`](https://github.com/kubernetes-sigs/metrics-server/releases/tag/v0.8.0)
- Vendored manifest: [`components.yaml`](https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.8.0/components.yaml)

The upstream `components.yaml` is kept locally so the lab has a reproducible Metrics Server version. `kustomization.yaml` applies `local-tls-patch.yaml` on top of that manifest.

## Docker Desktop TLS patch

Metrics Server normally verifies the TLS certificate presented by each kubelet. In this Docker Desktop lab, the kubelet serving certificate is not trusted or does not match the node address used by Metrics Server, so metric collection fails certificate validation.

`local-tls-patch.yaml` adds the following Metrics Server argument:

```text
--kubelet-insecure-tls
```

This disables validation of kubelet serving certificates. It is appropriate only for this local, single-user Docker Desktop lab. Do not use this patch in production or in a shared or untrusted cluster; configure properly signed kubelet serving certificates instead.

## Install

From the repository root, run:

```sh
kubectl apply -k k8s/addons/metrics-server
```

## Verify

Wait for the aggregated Metrics API to become available:

```sh
kubectl wait --for=condition=Available apiservice/v1beta1.metrics.k8s.io --timeout=120s
kubectl get apiservice v1beta1.metrics.k8s.io
```

Then confirm that Metrics Server returns node and pod usage:

```sh
kubectl top nodes
kubectl top pods --all-namespaces
```

Metrics can take a short time to appear after installation. If verification fails, inspect the deployment and its logs:

```sh
kubectl -n kube-system get deployment metrics-server
kubectl -n kube-system logs deployment/metrics-server
```
