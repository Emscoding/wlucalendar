#!/usr/bin/env bash
set -euo pipefail
# Installs @ffmpeg/ffmpeg locally and copies the dist files into public/vendor/ffmpeg/
# Run from project root: ./scripts/install-ffmpeg-vendor.sh
npm install @ffmpeg/ffmpeg --no-audit --no-fund
mkdir -p public/vendor/ffmpeg
cp -R node_modules/@ffmpeg/ffmpeg/dist/* public/vendor/ffmpeg/
echo "Copied @ffmpeg/ffmpeg dist files to public/vendor/ffmpeg/"
