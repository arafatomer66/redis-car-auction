import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3000),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6383",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://auction:auction@localhost:5436/auction",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:4200",
};
