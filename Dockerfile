# Agents App V0 control plane (web + control loop). Base pinned by multi-platform index digest (the same node image the gate pins in gate/images.json).
FROM node@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# `check` stage: what the repository gate runs as the candidate checks (types, lint, tests on PGlite).
FROM deps AS check
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["npm", "run", "check"]

FROM deps AS build
ARG APP_BUILD_ID=dev
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 APP_BUILD_ID=${APP_BUILD_ID} NEXT_PUBLIC_BUILD_ID=${APP_BUILD_ID}
RUN npm run typecheck && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG APP_BUILD_ID=dev
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/tmp PORT=3000 APP_BUILD_ID=${APP_BUILD_ID}
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle ./drizzle
USER 1000:1000
EXPOSE 3000
# `next start` listens on $PORT (3000 here; the gate preview sets 8080)
CMD ["node_modules/.bin/next", "start", "-H", "0.0.0.0"]
