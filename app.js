const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

app.get("/", (req, res) => {
  res.send("M.A.C. backend online");
});

app.get("/health", async (req, res) => {
  try {
    const status = {
      server: "ok",
      supabase_url: !!supabaseUrl,
      supabase_key: !!supabaseKey,
      gemini_key: !!geminiApiKey,
      supabase_connection: false
    };

    if (supabase) {
      const { error } = await supabase.from("empresas").select("id").limit(1);
      status.supabase_connection = !error;
      if (error) {
        status.supabase_error = error.message;
      }
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({
      server: "error",
      message: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor M.A.C. rodando na porta ${PORT}`);
});
