# Debian-based (glibc), not Alpine: better-sqlite3/sqlite-vec ship prebuilt
# glibc binaries via prebuild-install for most platforms, so this avoids a
# from-source compile in the common case. build-essential/python3 stay in as
# a fallback for whatever platform actually runs this build, so a missing
# prebuild degrades to "slower" rather than "fails".
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["mcp"]
