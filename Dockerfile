# Build once on the build machine's own platform (the output is plain JS), then assemble per target platform.
# The base image is pinned by digest; Dependabot proposes updates (.github/dependabot.yml).
FROM --platform=$BUILDPLATFORM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
# .npmrc: installed packages may not run install scripts.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
