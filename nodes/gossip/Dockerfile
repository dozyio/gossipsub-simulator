FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./

COPY . .

# RUN npm ci

CMD [ "node", "gossip-peer.js" ]

