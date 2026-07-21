FROM node:22-alpine AS build

WORKDIR /app
COPY . .

RUN corepack enable && corepack prepare pnpm@10 --activate
RUN npm install -g dotenv dotenv-cli

RUN pnpm install
RUN pnpm run build

FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate
RUN npm install -g dotenv dotenv-cli
COPY --from=build /app /app

CMD ["pnpm", "run", "afterbuild"]
