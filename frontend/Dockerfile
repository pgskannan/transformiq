# Static build served by a lightweight web server. Not deployed anywhere yet.
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Vite inlines import.meta.env.VITE_* at build time (vite build), not at container-run time —
# a plain `environment:` entry in docker-compose.yml for a service that just serves this
# already-built bundle via nginx has no effect. Take it as a build ARG instead so
# docker-compose's `build.args` can actually reach it.
ARG VITE_API_BASE_URL=http://localhost:8080
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
