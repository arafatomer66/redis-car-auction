import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { env } from "./config/env.js";
import { healthRouter } from "./routes/health.js";
import { auctionsRouter } from "./routes/auctions.js";
import { bidsRouter } from "./routes/bids.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { opsRouter } from "./routes/ops.js";
import { attachSockets } from "./sockets/auctionSocket.js";
import { startExpiryWorker } from "./workers/expiryWorker.js";
import { startAnalyticsWorker } from "./workers/analyticsWorker.js";
import { startNotifyWorker } from "./workers/notifyWorker.js";
import { loadAuctionFunctions } from "./redis/functions.js";

const app = express();
app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.use("/health", healthRouter);
app.use("/auctions", auctionsRouter);
app.use("/", bidsRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/ops", opsRouter);

const server = createServer(app);
attachSockets(server);
startExpiryWorker();
startAnalyticsWorker();
startNotifyWorker();
loadAuctionFunctions().catch(() => {});

server.listen(env.port, () => {
  console.log(`[api] listening on http://localhost:${env.port}`);
});
