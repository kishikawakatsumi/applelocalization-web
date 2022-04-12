FROM denoland/deno:ubuntu-1.18.2

WORKDIR /app

COPY deps.ts .
RUN deno cache --reload --unstable deps.ts

ADD . .
RUN deno cache --reload --unstable main.ts

EXPOSE 8080
CMD ["run", "--allow-env", "--allow-net", "--allow-read", "main.ts"]