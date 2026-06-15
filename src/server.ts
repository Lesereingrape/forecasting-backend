import { createApp } from "./app.js";
import { prisma } from "./db.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`forecasting backend listening on http://localhost:${port}`);
});

process.on("SIGINT", async () => {
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});
