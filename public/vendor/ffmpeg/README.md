This folder is intended to hold the @ffmpeg/ffmpeg distribution files used by the client-side ffmpeg.wasm loader.

To populate these files, run from the project root:

  npm run install-vendor-ffmpeg

or run the helper script:

  ./scripts/install-ffmpeg-vendor.sh

This will install @ffmpeg/ffmpeg into node_modules and copy the contents of
node_modules/@ffmpeg/ffmpeg/dist/ into this folder so the browser can load
ffmpeg.wasm and related assets same-origin (required for SharedArrayBuffer
when COOP/COEP are enabled).
