{
  description = "glyph backend — deploy the backend service image";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Same flow as ../velox: derive the GHCR repo from the origin remote,
        # build with podman, push, and roll out the deployment. Never run
        # unless explicitly asked. The build context is the repository root,
        # because build.rs compiles ../proto (see backend/Containerfile).
        deploy = pkgs.writeShellApplication {
          name = "deploy";
          runtimeInputs = [
            pkgs.git
            pkgs.podman
            pkgs.kubectl
          ];
          text = ''
            set -euo pipefail

            ROOT=$(git rev-parse --show-toplevel)

            REGISTRY="ghcr.io"
            REPO=$(git remote get-url origin 2>/dev/null | sed -E 's|.*github\.com[:/]||' | sed 's/\.git$//' || echo "$USER/glyph-v2")
            TAG="''${REGISTRY}/''${REPO}:latest"

            if [ -n "''${GITHUB_TOKEN:-}" ]; then
              echo "$GITHUB_TOKEN" | podman login "$REGISTRY" -u "josevictorferreira" --password-stdin
            else
              echo "GITHUB_TOKEN not set; assuming already logged in to $REGISTRY."
            fi

            podman build --platform=linux/amd64 --file "$ROOT/backend/Containerfile" --tag "$TAG" "$ROOT"
            podman push "$TAG"
            echo "Successfully pushed image: $TAG"

            # Flux owns the Deployment and strips the annotation `rollout restart`
            # adds, rolling back to the old pod. Recreate the pods instead:
            # imagePullPolicy is Always, so they pull the image pushed above.
            echo "Recreating glyph pods in apps namespace"
            kubectl -n apps delete pod -l app.kubernetes.io/name=glyph --wait=false
            kubectl -n apps rollout status deployment/glyph --timeout=600s
          '';
        };
      in
      {
        packages.deploy = deploy;
        apps.deploy = {
          type = "app";
          program = "${deploy}/bin/deploy";
        };
        formatter = pkgs.nixfmt;
      }
    );
}
