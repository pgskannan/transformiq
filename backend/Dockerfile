# Multi-stage build for Cloud Run. Not deployed anywhere yet — see ADR 0002 "This scaffold
# is code + IaC, not a deployed system."
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
