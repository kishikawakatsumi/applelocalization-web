FROM node:lts-slim as node

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY webpack.*.js ./
COPY . .
RUN npx webpack --config webpack.prod.js

FROM denoland/deno

WORKDIR /app

COPY --from=node /build/dist ./dist

COPY backend/deps.ts .
RUN deno cache --reload deps.ts

ADD backend .
RUN deno cache main.ts

EXPOSE 8080
CMD ["run", "--allow-env", "--allow-net", "--allow-read", "main.ts"]
