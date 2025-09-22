FROM node:20.3.0-alpine AS build

WORKDIR /app
COPY . .

RUN npm install -g pnpm dotenv dotenv-cli

RUN pnpm install
RUN pnpm run build

FROM node:20.3.0-alpine

WORKDIR /app

RUN npm install -g pnpm dotenv dotenv-cli
COPY --from=build /app /app

CMD ["pnpm", "run", "afterbuild"]
