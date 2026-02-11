import express from "express";

const app = express();
const PORT = process.env.PORT || 8081;

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "arknas-api",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/meta", (_req, res) => {
  res.json({
    name: "ArkNAS Hub API",
    version: "0.1.0"
  });
});

app.listen(PORT, () => {
  console.log(`arknas-api listening on ${PORT}`);
});

