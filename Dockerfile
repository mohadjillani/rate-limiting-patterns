FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "src/demo/server.ts"]
