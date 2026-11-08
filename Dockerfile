ARG BASE_IMAGE=node:22-bookworm
FROM ${BASE_IMAGE}
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npx playwright install --with-deps chromium
COPY . .
ENV HOST=0.0.0.0 PORT=8080 PYTHONDONTWRITEBYTECODE=1
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+process.env.PORT+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
