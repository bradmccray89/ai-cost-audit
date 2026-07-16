---
name: deploy
description: Deploy a service to staging or production with the standard checklist
---

# Deploy skill

To deploy a service, first run the full test suite and confirm it passes. Then build
the container image and tag it with the current git SHA. Push the image to the
registry. Update the deployment manifest with the new tag. Apply the manifest with
kubectl and watch the rollout status until it completes. If the rollout fails, roll
back immediately with kubectl rollout undo and page the on-call engineer.

## Checklist

1. Tests green on main
2. Image built and tagged with git SHA
3. Manifest updated and applied
4. Rollout watched to completion
5. Smoke test the health endpoint
