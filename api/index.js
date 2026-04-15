// api/index.js - Versão mínima estável para diagnosticar o erro 500

const cors = require("cors");
const express = require("express");

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

console.log("✅ Backend M.A.C iniciado em modo diagnóstico");

app.get("/", (req, res) => {
  res.send("M.A.C. backend online - Modo Diagnóstico");
});

app.get("/health", (req, res) => {
  res.json({
    server: "ok",
    status: "running",
    message: "Backend rodando sem crash",
    timestamp: new Date().toISOString(),
    env: {
      supabase: !!process.env.SUPABASE_URL,
      gemini: !!process.env.GEMINI_API_KEY
    }
  });
});

app.post("/chat", (req, res) => {
  res.json({
    ok: true,
    resposta: "Backend está online em modo diagnóstico. A análise completa será restaurada em breve.",
    origem_resposta: "diagnostico"
  });
});

module.exports = app;
