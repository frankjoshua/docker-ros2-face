#!/bin/bash
set -euo pipefail

usage() {
    echo "Usage: $0 -t <DOCKER_TAG> [-a <ARCHITECTURE>] [-b <BASE_IMAGE>] [-p Push] [-l Local build] [-q Quiet]"
    echo "Default architecture: linux/arm64,linux/amd64"
    echo "Default base image:   Dockerfile BASE_IMAGE arg (e.g. -b frankjoshua/ros2:humble)"
    exit 1
}

TAG=""
ARCHITECTURE="linux/arm64,linux/amd64"
BASE_IMAGE=""
PUSH=false
LOCAL=false
QUIET=false
while getopts ":a:b:t:pql" o; do
    case "$o" in
        t) TAG="$OPTARG" ;;
        b) BASE_IMAGE="$OPTARG" ;;
        p) PUSH=true ;;
        q) QUIET=true ;;
        a) ARCHITECTURE="$OPTARG" ;;
        l) LOCAL=true ;;
        :) echo "ERROR: Option -$OPTARG requires an argument"; usage ;;
        \?) echo "ERROR: Invalid option -$OPTARG"; usage ;;
    esac
done
shift $((OPTIND - 1))
if [[ -z "$TAG" || $# -ne 0 ]]; then
    usage
fi

if ! docker buildx version > /dev/null; then
    echo "Docker Buildx is required" >&2
    exit 1
fi

# Arrays preserve literal arguments; never evaluate user input as shell code.
build_args=(buildx build -t "$TAG" --target prod)
if [[ -n "$BASE_IMAGE" ]]; then
    build_args+=(--build-arg "BASE_IMAGE=$BASE_IMAGE")
fi
if $PUSH; then
    build_args+=(--push)
elif $LOCAL; then
    build_args+=(--load)
fi

if ! $LOCAL; then
    echo "Creating multi platform builder."
    BUILDER=$(docker buildx create)
    # Preserve the original status even if cleanup itself fails.
    trap 'docker buildx rm "$BUILDER" >/dev/null 2>&1 || true' EXIT
    docker run --rm --privileged multiarch/qemu-user-static --reset -p yes --credential yes
    build_args+=(--builder "$BUILDER" --platform "$ARCHITECTURE")
fi

if $QUIET; then
    docker "${build_args[@]}" . 2>/dev/null
else
    docker "${build_args[@]}" .
fi
