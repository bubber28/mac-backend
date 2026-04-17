const cors = require("cors");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const { buildMacPrompt } = require("../mac/macPromptBuilder");
const { analyzeMessage } = require("../mac/macAnalyzer");

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

const genAI = geminiApiKey
  ? new GoogleGenerativeAI(geminiApiKey)
  : null;

console.log("✅ M.A.C Backend iniciado");
console.log("Supabase:", !!supabase);
console.log("Gemini:", !!genAI);

// ==================== FUNÇÕES AUXILIARES ====================

function formatarPreco(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  if (Number.isNaN(numero)) return `R$ ${valor}`;
  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function normalizarTexto(texto = "") {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizarTexto(texto = "") {
  const stopWords = new Set([
    "de", "da", "do", "das", "dos",
    "a", "o", "as", "os",
    "e", "em", "no", "na", "nos", "nas",
    "um", "uma", "uns", "umas",
    "pro", "pra", "para", "com", "que",
    "tem", "quero", "quanto", "custa",
    "mostra", "mostrar", "ver"
  ]);

  return normalizarTexto(texto)
    .split(" ")
    .filter((t) => t && t.length > 1 && !stopWords.has(t));
}

function temIntersecaoPorPrefixo(token, baseTokens = []) {
  return baseTokens.some((base) => {
    if (!base) return false;
    if (token === base) return true;
    if (token.length >= 4 && base.startsWith(token)) return true;
    if (base.length >= 4 && token.startsWith(base)) return true;
    return false;
  });
}

function detectarItensPorMensagem(servicos = [], mensagem = "") {
  if (!Array.isArray(servicos) || servicos.length === 0) return [];

  const mensagemNormalizada = normalizarTexto(mensagem);
  const tokensMensagem = tokenizarTexto(mensagem);

  return servicos
    .map((servico) => {
      const nome = servico?.nome_servico || servico?.nome || "";
      const descricao = servico?.descricao || servico?.descricao_servico || "";
      const nomeNormalizado = normalizarTexto(nome);
      const descricaoNormalizada = normalizarTexto(descricao);
      const tokensNome = tokenizarTexto(nomeNormalizado);
      const tokensDescricao = tokenizarTexto(descricaoNormalizada);

      let scoreNome = 0;
      let scoreDescricao = 0;

      if (nomeNormalizado && mensagemNormalizada.includes(nomeNormalizado)) {
        scoreNome += 8;
      }

      for (const token of tokensMensagem) {
        if (temIntersecaoPorPrefixo(token, tokensNome)) scoreNome += 3;
        if (temIntersecaoPorPrefixo(token, tokensDescricao)) scoreDescricao += 1.5;
      }

      if (
        mensagemNormalizada.includes("combo") &&
        (
          nomeNormalizado.includes("combo") ||
          descricaoNormalizada.includes("combo") ||
          descricaoNormalizada.includes("festa") ||
          descricaoNormalizada.includes("evento")
        )
      ) {
        scoreNome += 3;
      }

      const scoreTotal = Number((scoreNome * 0.7 + scoreDescricao * 0.3).toFixed(2));

      return {
        servico,
        score_nome: Number(scoreNome.toFixed(2)),
        score_descricao: Number(scoreDescricao.toFixed(2)),
        score_total: scoreTotal,
      };
    })
    .filter((item) => item.score_total >= 2)
    .sort((a, b) => b.score_total - a.score_total);
}

function identificarPedidoCardapio(mensagem = "") {
  const texto = normalizarTexto(mensagem);
  const termosCardapio = [
    "cardapio",
    "menu",
    "o que tem",
    "me mostra",
    "quais opcoes",
    "mostra o que tem",
    "quero ver",
  ];

  return termosCardapio.some((termo) => texto.includes(termo));
}

function montarVitrineInicial(servicos = [], mensagem = "", limite = 6) {
  if (!Array.isArray(servicos) || servicos.length === 0) return [];

  const msg = normalizarTexto(mensagem);
  const querSalgado = msg.includes("salgado") || msg.includes("salgadin");

  const servicosFiltrados = querSalgado
    ? servicos.filter((item) => {
        const alvo = normalizarTexto(
          `${item?.nome_servico || ""} ${item?.descricao || ""} ${item?.tipo_item || ""}`
        );

        return (
          alvo.includes("salgad") ||
          alvo.includes("coxinha") ||
          alvo.includes("quibe") ||
          alvo.includes("bolinha") ||
          alvo.includes("esfiha") ||
          alvo.includes("empada")
        );
      })
    : servicos;

  const base = servicosFiltrados.length > 0 ? servicosFiltrados : servicos;

  return base.slice(0, limite).map((item) => ({
    nome: item?.nome_servico || item?.nome || "Item",
    preco: formatarPreco(item?.preco),
    descricao: (item?.descricao || "").trim() || null,
  }));
}

function construirEvidenciasBanco({
  mensagem,
  analiseMensagem,
  servicos = [],
  contextoVenda = "padrao",
}) {
  const itensRankeados = detectarItensPorMensagem(servicos, mensagem);
  const principal = itensRankeados[0] || null;
  const pediuCardapio = identificarPedidoCardapio(mensagem);
  const intencaoDetectada = analiseMensagem?.intencaoDetectada || "duvida_geral";
  const vitrineInicial = pediuCardapio
    ? montarVitrineInicial(servicos, mensagem)
    : [];

  return {
    pediu_cardapio: pediuCardapio,
    intencao_detectada: intencaoDetectada,
    origem_detector_itens: "detectarItensPorMensagem",
    detector_cardapio_ativo: true,
    servico_detectado_principal: principal
      ? {
          nome_servico:
            principal.servico?.nome_servico || principal.servico?.nome || null,
          descricao:
            principal.servico?.descricao ||
            principal.servico?.descricao_servico ||
            null,
          preco: principal.servico?.preco ?? null,
          score_nome: principal.score_nome,
          score_descricao: principal.score_descricao,
          score_total: principal.score_total,
        }
      : null,
    preco_item_principal_formatado: principal
      ? formatarPreco(principal.servico?.preco)
      : null,
    itens_detectados: itensRankeados.slice(0, 5).map((item) => ({
      nome_servico: item.servico?.nome_servico || item.servico?.nome || null,
      preco: item.servico?.preco ?? null,
      score_nome: item.score_nome,
      score_descricao: item.score_descricao,
      score_total: item.score_total,
    })),
    vitrine_inicial: vitrineInicial,
    contexto_venda: contextoVenda,
  };
}

async function carregarContextoEmpresa(empresaId, canal = "whatsapp") {
  const fallback = {
    empresa: {
      id: empresaId,
      canal_principal: canal,
    },
    config_mac: {
      modo_atendimento: "whatsapp",
      objetivo: "conversao",
      tom_padrao: "humano",
    },
    servicos: [],
    faq: [],
  };

  if (!supabase || !empresaId) {
    return fallback;
  }

  try {
    let empresa = null;
    let configMac = null;
    let servicos = [];
    let faq = [];

    const empresaResp = await supabase
      .from("empresas")
      .select("*")
      .eq("id", empresaId)
      .maybeSingle();

    if (empresaResp.error) {
      console.error("Erro ao buscar empresa:", empresaResp.error.message);
    } else {
      empresa = empresaResp.data;
    }

    const configResp = await supabase
      .from("config_mac")
      .select("*")
      .eq("empresa_id", empresaId)
      .maybeSingle();

    if (configResp.error) {
      console.error("Erro ao buscar config_mac:", configResp.error.message);
    } else {
      configMac = configResp.data;
    }

    const servicosResp = await supabase
      .from("servicos")
      .select("*")
      .eq("empresa_id", empresaId)
      .eq("ativo", true)
      .order("nome_servico", { ascending: true });

    if (servicosResp.error) {
      console.error("Erro ao buscar servicos:", servicosResp.error.message);
    } else {
      servicos = servicosResp.data || [];
    }

    const faqResp = await supabase
      .from("faq")
      .select("*")
      .eq("empresa_id", empresaId)
      .order("created_at", { ascending: true });

    if (faqResp.error) {
      console.error("Erro ao buscar faq:", faqResp.error.message);
    } else {
      faq = faqResp.data || [];
    }

    return {
      empresa: empresa || fallback.empresa,
      config_mac: configMac || fallback.config_mac,
      servicos,
      faq,
    };
  } catch (error) {
    console.error("Erro ao carregar contexto da empresa:", error?.message || error);
    return fallback;
  }
}

// ==================== ROTAS ====================

app.get("/", (req, res) => {
  res.send("M.A.C. backend online");
});

app.get("/health", (req, res) => {
  res.json({
    server: "ok",
    status: "running",
    message: "Backend funcionando sem crash",
    supabase: !!supabase,
    gemini: !!genAI,
    timestamp: new Date().toISOString(),
  });
});

app.post("/chat", async (req, res) => {
  try {
    const { empresa_id, nome, telefone, canal = "whatsapp", mensagem } = req.body;

    if (!empresa_id || !telefone || !mensagem) {
      return res.status(400).json({
        error: "Dados obrigatórios faltando",
      });
    }

    const analiseMensagem = analyzeMessage(mensagem);
    const contextoEmpresa = await carregarContextoEmpresa(empresa_id, canal);

    const evidenciasBanco = construirEvidenciasBanco({
      mensagem,
      analiseMensagem,
      servicos: contextoEmpresa.servicos,
      contextoVenda: "padrao"
    });

    let promptFinal = "";

    try {
      promptFinal = buildMacPrompt({
        contextoEmpresa,
        mensagemCliente: mensagem,
        analiseMensagem,
        perfilLead: null,
        estadoConversa: null,
        evidenciasBanco
      });
    } catch (errorPrompt) {
      console.error("Erro ao montar prompt:", errorPrompt?.message || errorPrompt);
    }

    let respostaFinal =
      "Vou te responder da forma mais certa. Me fala só mais um detalhe para eu te orientar melhor.";

    if (genAI && promptFinal) {
      try {
        const model = genAI.getGenerativeModel({
          model: "gemini-3-flash-preview"
        });

        const result = await model.generateContent(promptFinal);
        const textoGemini = result?.response?.text?.() || "";

        if (textoGemini.trim()) {
          respostaFinal = textoGemini.trim();
        }
      } catch (errorGemini) {
        console.error("Erro Gemini:", errorGemini?.message || errorGemini);
      }
    }

    return res.json({
      ok: true,
      lead_id: "temp",
      resposta: respostaFinal,
      origem_resposta: "mac_ativo",
      canal,
      nome: nome || null,
      analise: {
        intencao_detectada: analiseMensagem?.intencaoDetectada || null,
        perfil_hipotese: analiseMensagem?.perfilHipotese || null,
      }
    });
  } catch (err) {
    console.error("Erro /chat:", err);
    return res.status(500).json({
      error: "Erro interno",
      detalhes: err?.message || "Falha desconhecida",
    });
  }
});

module.exports = app;
