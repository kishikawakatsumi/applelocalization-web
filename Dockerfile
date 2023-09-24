FROM node:lts-slim as node

WORKDIR /build

ARG FONTAWESOME_TOKEN
COPY package*.json ./
RUN echo "@fortawesome:registry=https://npm.fontawesome.com/\n//npm.fontawesome.com/:_authToken=${FONTAWESOME_TOKEN}" > ./.npmrc \
    && npm ci \
    && rm -f ./.npmrc

COPY webpack.*.js ./
COPY . .
RUN npx webpack --config webpack.prod.js

FROM denoland/deno:ubuntu-1.37.0

WORKDIR /app

COPY --from=node /build/dist ./dist

COPY backend/deps.ts .
RUN deno cache --reload deps.ts

ADD backend .
RUN deno cache main.ts

EXPOSE 8080
CMD ["run", "--allow-env", "--allow-net", "--allow-read", "main.ts"]
