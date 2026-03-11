FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src/ ./src/
COPY selftest.js ./
COPY toggle-debug.ps1 ./

ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
