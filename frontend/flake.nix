{
  description = "glyph frontend — deploy the frontend service image";

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
        # unless explicitly asked. The build context is this directory only
        # (generated gRPC code is committed), so the image is independent of
        # backend/ and proto/.
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
            TAG="''${REGISTRY}/''${REPO}-frontend:latest"

            if [ -n "''${GITHUB_TOKEN:-}" ]; then
              echo "$GITHUB_TOKEN" | podman login "$REGISTRY" -u "josevictorferreira" --password-stdin
            else
              echo "GITHUB_TOKEN not set; assuming already logged in to $REGISTRY."
            fi

            podman build --platform=linux/amd64 --file "$ROOT/frontend/Containerfile" --tag "$TAG" "$ROOT/frontend"
            podman push "$TAG"
            echo "Successfully pushed image: $TAG"

            echo "Restarting glyph-frontend deployment in apps namespace"
            kubectl -n apps rollout restart deployment/glyph-frontend
            kubectl -n apps rollout status deployment/glyph-frontend --timeout=600s
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
