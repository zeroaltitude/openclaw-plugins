# Deployment Guide

## Prerequisites

- Docker (for building the image)
- AWS CLI configured with ECR access
- kubectl configured for target cluster
- Helm 3.x

## 1. Build & Push Docker Image

```bash
# Set your ECR repo
export ECR_REPO=123456789.dkr.ecr.us-west-2.amazonaws.com/vestige

# Login to ECR
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin $ECR_REPO

# Build
docker build -t $ECR_REPO:latest -f docker/Dockerfile .

# Push
docker push $ECR_REPO:latest
```

> **Note**: The Dockerfile verifies a SHA256 checksum of the downloaded Vestige binary.
> Before production use, update the `VESTIGE_SHA256` build arg in the Dockerfile with the
> actual checksum from the release.

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
  --set image.repository=$ECR_REPO \
  --set image.tag=latest \
  --set auth.token="your-secure-token-here"
```

### Custom values file

Create `values-prod.yaml`:

```yaml
image:
  repository: 123456789.dkr.ecr.us-west-2.amazonaws.com/vestige
  tag: "v0.1.0"

ingress:
  # Optional: ACM certificate for ALB HTTPS termination
  certificateArn: "arn:aws:acm:us-west-2:123456789:certificate/your-cert-id"
  hosts:
    - host: vestige.internal.yourcompany.com
      paths:
        - path: /
          pathType: Prefix

resources:
  requests:
    cpu: 250m
    memory: 384Mi
  limits:
    cpu: 500m
    memory: 512Mi

persistence:
  size: 10Gi
```

```bash
helm install vestige helm/vestige/ \
  --namespace openclaw \
  -f values-prod.yaml \
  --set auth.token="$(openssl rand -base64 32)"
```

## 4. Startup & Probes

The Helm chart configures three probes:

| Probe | Endpoint | Purpose |
|-------|----------|---------|
| **Startup** | `GET /health` | Allows up to **5 minutes** (30 × 10s) for initial model download |
| **Liveness** | `GET /health` | Restarts pod if vestige-mcp process dies |
| **Readiness** | `GET /readyz` | Removes from service if not ready |

On first boot, Vestige downloads the Nomic Embed Text v1.5 model (~130MB). The startup
probe prevents Kubernetes from killing the pod during this download. Subsequent restarts
use the cached model from the PVC.

The `/health` endpoint returns **503** when the MCP process is not alive, so liveness
probes will correctly detect a dead subprocess.

## 5. Verify Deployment

```bash
# Check pods
kubectl get pods -n openclaw -l app.kubernetes.io/name=vestige

# Check logs (look for "Vestige tools discovered" to confirm startup)
kubectl logs -n openclaw -l app.kubernetes.io/name=vestige -f

# Health check (port-forward)
kubectl port-forward -n openclaw svc/vestige 8000:8000
curl http://localhost:8000/health
curl http://localhost:8000/readyz
```

## 6. Configure OpenClaw Plugin

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
# Build new image
docker build -t $ECR_REPO:v0.2.0 -f docker/Dockerfile .
docker push $ECR_REPO:v0.2.0

# Upgrade release
helm upgrade vestige helm/vestige/ \
  --namespace openclaw \
  --set image.tag=v0.2.0
```

## Troubleshooting

### Pod stuck in CrashLoopBackOff

Check logs:
```bash
kubectl logs -n openclaw <pod-name> --previous
```

Common causes:
- vestige-mcp binary not found → check Dockerfile build
- GLIBC version mismatch → ensure Ubuntu 24.04 base image
- Model download failure → check internet access from pod
- Auth token empty → ensure `auth.token` or `auth.existingSecret` is set

### SQLite lock errors

Only one replica can run at a time. Ensure `strategy.type: Recreate` in the deployment (this is the default in our chart).

### Memory issues

If OOMKilled, increase memory limit:
```bash
helm upgrade vestige helm/vestige/ \
  --set resources.limits.memory=768Mi
```

### Authentication errors (500 at startup)

If you see "Authentication not configured" in logs, either:
1. Set `VESTIGE_AUTH_TOKEN` to a non-empty value, or
2. For dev: set `VESTIGE_ALLOW_ANONYMOUS=true`

### Data recovery

If you need to restore from backup:
```bash
kubectl exec -n openclaw <pod-name> -- vestige-restore /data/backup.db
```
