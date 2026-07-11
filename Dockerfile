FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

# History database lives here — mount a volume to persist it.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data

EXPOSE 3000
USER node
CMD ["node", "server.js"]
