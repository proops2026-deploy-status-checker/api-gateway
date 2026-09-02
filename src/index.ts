import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

// Walking skeleton: health check only, no routing/auth logic yet (TIE-9)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`api-gateway listening on port ${port}`);
});
