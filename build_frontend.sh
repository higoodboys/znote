#!/bin/sh
set -e

BASE_DIR=$(pwd)

mkdir -p "$BASE_DIR/public/static/assets"
mkdir -p "$BASE_DIR/public/static/vditor"

cd "$BASE_DIR/frontend"
# bun run icons:sync
bun run build
cd "$BASE_DIR"

rm -rf "$BASE_DIR/public/static/assets"/*
cp -ar "$BASE_DIR/frontend/dist/static/assets"/* "$BASE_DIR/public/static/assets/"
cp -ar "$BASE_DIR/frontend/dist/static/vditor"/* "$BASE_DIR/public/static/vditor/"

# bun run output
