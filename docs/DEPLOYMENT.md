# Deployment Guide

## Prerequisites

- Docker (for building images)
- AWS CLI configured with ECR access
- kubectl configured for target cluster
- Helm 3.x

## 1. Build & Push Docker Images

The system uses two separate images:

```bash
# Set your ECR repos
export ECR_VESTIGE=123456789.dkr.ecr.us-west-2.amazonaws.com/vestige-mcp
export ECR_BRIDGE=123456789.dkr.ecr.us-west-2.amazonaws.com/vestige-bridge

# Login to ECR
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin $ECR_VESTIGE

# Build Vestige (MCP server + supergateway)
docker build -t $ECR_VESTIGE:latest -f docker/Dockerfile.vestige .
docker push $ECR_VESTIGE:latest

# Build Bridge (FastAPI)
docker build -t $ECR_BRIDGE:latest -f docker/Dockerfile.bridge .
docker push $ECR_BRIDGE:latest
```

> **Note**: The Vestige Dockerfile verifies a SHA256 checksum of the downloaded binary.
> Before production use, update the `VESTIGE_SHA256` build arg with the actual checksum.

## 2. Authentication Setup

**Authentication is required by default.** The Helm chart will fail to render if
`auth.token` is empty and `auth.existingSecret` is not provided.

Option A — Let Helm create the secret:
```bash
helm install vestige helm/vestige/ \
  --set auth.token="your-secure-token-here"
```

Option B — Pre-create a k8s secret:
```bash
kubectl create secret generic vestige-auth \
  --from-literal=token="your-secure-token-here"

helm install vestige helm/vestige/ \
  --set auth.existingSecret=vestige-auth
```

> **⚠️ Never deploy with an empty auth token.** For local development without auth,
> set `VESTIGE_ALLOW_ANONYMOUS=true` in the environment (not recommended for production).

## 3. Deploy with Helm

```bash
helm install vestige helm/vestige/ \
  --namespace openclaw \
  --create-namespace \
  --set vestigeImage.repository=$ECR_VESTIGE \
  --set vestigeImage.tag=latest \
  --set bridgeImage.repository=$ECR_BRIDGE \
  --set bridgeImage.tag=latest \
  --set auth.token="your-secure-token-here"
```

### Custom values file

Create `values-prod.yaml`:

```yaml
vestigeImage:
  repository: 123456789.dkr.ecr.us-west-2.amazonaws.com/vestige-mcp
  tag: "v0.2.0"

bridgeImage:
  repository: 123456789.dkr.ecr.us-west-2.amazonaws.com/vestige-bridge
  tag: "v0.2.0"

ingress:
  certificateArn: "arn:aws:acm:us-west-2:123456789:certificate/your-cert-id"
  hosts:
    - host: vestige.internal.yourcompany.com
      paths:
        - path: /
          pathType: Prefix

vestigeResources:
  requests:
    cpu: 250m
    memory: 384Mi
  limits:
    cpu: 500m
    memory: 512Mi

bridgeResources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 250m
    memory: 256Mi

persistence:
  size: 10Gi
```

```bash
helm install vestige helm/vestige/ \
  --namespace openclaw \
  -f values-prod.yaml \
  --set auth.token="$(openssl rand -base64 32)"
```

## 4. Pod Architecture

The Helm chart deploys a single pod with two containers (sidecar pattern):

```
┌─── Pod ──────────────────────────────────────────────┐
│                                                       │
│  ┌──────────────┐   localhost:3100   ┌──────────────┐│
│  │    bridge     │ ────────────────▶ │  vestige-mcp ││
│  │  (port 8000)  │                   │  (port 3100)  ││
│  └──────────────┘                   └──────────────┘│
│         │                                  │          │
│    Service:8000                       /data PVC       │
│    (external)                       (shared volume)   │
└───────────────────────────────────────────────────────┘
```

- **vestige-mcp**: Runs supergateway wrapping vestige-mcp. Only accessible on localhost within the pod.
- **bridge**: Runs FastAPI with auth. Exposed via Service and Ingress on port 8000.
- **Shared PVC**: Both containers share `/data` for SQLite and embedding cache.

## 5. Startup & Probes

Each container has independent probes:

### Vestige MCP Container

| Probe | Method | Purpose |
|-------|--------|---------|
| **Startup** | `curl POST /mcp` | Allows up to **5 minutes** (30 × 10s) for initial model download |
| **Liveness** | `curl POST /mcp` | Restarts container if supergateway dies |
| **Readiness** | `curl POST /mcp` | Removes from service if not responding |

### Bridge Container

| Probe | Endpoint | Purpose |
|-------|----------|---------|
| **Startup** | `GET /health` | Allows up to **60 seconds** (12 × 5s) for initial connection |
| **Liveness** | `GET /health` | Restarts if bridge is unhealthy |
| **Readiness** | `GET /readyz` | Removes from service if Vestige connection is lost |

On first boot, Vestige downloads the Nomic Embed Text v1.5 model (~130MB). The vestige
container startup probe prevents Kubernetes from killing the pod during this download.
Subsequent restarts use the cached model from the PVC.

The bridge `/health` endpoint performs a deep health check — it sends a `tools/list`
request to Vestige and returns 503 if Vestige is unreachable.

## 6. Verify Deployment

```bash
# Check pods (should show 2/2 READY)
kubectl get pods -n openclaw -l app.kubernetes.io/name=vestige

# Check logs for vestige container
kubectl logs -n openclaw -l app.kubernetes.io/name=vestige -c vestige-mcp -f

# Check logs for bridge container (look for "Vestige tools discovered")
kubectl logs -n openclaw -l app.kubernetes.io/name=vestige -c bridge -f

# Health check (port-forward)
kubectl port-forward -n openclaw svc/vestige 8000:8000
curl http://localhost:8000/health
curl http://localhost:8000/readyz
```

## 7. Configure OpenClaw Plugin

Add to your OpenClaw plugin configuration:

```json
{
  "plugins": {
    "vestige": {
      "settings": {
        "serverUrl": "http://vestige.openclaw.svc.cluster.local:8000",
        "authToken": "your-secure-token-here"
      }
    }
  }
}
```

> **Note**: The plugin strips trailing slashes from `serverUrl` automatically.

## Upgrading

```bash
# Build new images
docker build -t $ECR_VESTIGE:v0.2.0 -f docker/Dockerfile.vestige .
docker push $ECR_VESTIGE:v0.2.0

docker build -t $ECR_BRIDGE:v0.2.0 -f docker/Dockerfile.bridge .
docker push $ECR_BRIDGE:v0.2.0

# Upgrade release
helm upgrade vestige helm/vestige/ \
  --namespace openclaw \
  --set vestigeImage.tag=v0.2.0 \
  --set bridgeImage.tag=v0.2.0
```

## Troubleshooting

### Pod stuck in CrashLoopBackOff

Check logs for each container:
```bash
kubectl logs -n openclaw <pod-name> -c vestige-mcp --previous
kubectl logs -n openclaw <pod-name> -c bridge --previous
```

Common causes:
- **vestige-mcp**: Binary not found, GLIBC version mismatch, model download failure
- **bridge**: Cannot connect to vestige (check VESTIGE_MCP_URL), auth token issues

### Bridge shows "Vestige connection lost"

The bridge will automatically reconnect on the next request. Check that the vestige-mcp
container is healthy:
```bash
kubectl exec -n openclaw <pod-name> -c bridge -- \
  python3 -c "import urllib.request; print(urllib.request.urlopen('http://localhost:3100/mcp').status)"
```

### SQLite lock errors

Only one replica can run at a time. Ensure `strategy.type: Recreate` in the deployment
(this is the default in our chart).

### Memory issues

If OOMKilled, increase memory limits for the appropriate container:
```bash
helm upgrade vestige helm/vestige/ \
  --set vestigeResources.limits.memory=768Mi \
  --set bridgeResources.limits.memory=384Mi
```

### Authentication errors (500 at startup)

If you see "Authentication not configured" in bridge logs, either:
1. Set `VESTIGE_AUTH_TOKEN` to a non-empty value, or
2. For dev: set `VESTIGE_ALLOW_ANONYMOUS=true`

### Data recovery

If you need to restore from backup:
```bash
kubectl exec -n openclaw <pod-name> -c vestige-mcp -- vestige-restore /data/backup.db
```
