# Pinned build environment. Nixpacks guessed npm 9 and tried to compile
# better-sqlite3 from source; pinning the base image and skipping install
# scripts keeps the build identical everywhere and free of a C toolchain.
FROM node:22-slim

WORKDIR /app

# Dependencies first so edits to src/ don't invalidate the install layer.
# --ignore-scripts is load-bearing: better-sqlite3 carries a binding.gyp, so npm
# would run `node-gyp rebuild` and need a C toolchain this image doesn't have.
# It ships prebuilt binaries for linux-x64/arm64, which is what we want anyway.
# Nothing else in the tree needs an install script at build time.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Cooldowns + snapshot history live on the mounted volume, not in the image.
ENV DB_PATH=/data/oi-scanner.db

CMD ["node", "dist/index.js", "--loop"]
