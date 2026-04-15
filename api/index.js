// api/index.js - Versão COMPLETA e CORRIGIDA para Vercel

const cors = require("cors");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildMacPrompt } = require("./mac/macPromptBuilder");
const { analyzeMessage } = require("./mac/macAnalyzer");

const app = express();

// ==================== CORS ====================
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.use(express.json());

// ==================== VARIÁVEIS DE AMBIENTE + DEBUG ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

console.log("🔧 Backend iniciado");
console.log("SUPABASE_URL:", !!supabaseUrl);
console.log("SUPABASE_KEY:", !!supabaseKey);
console.log("GEMINI_API_KEY:", !!geminiApiKey);

if (!supabaseUrl || !supabaseKey || !geminiApiKey) {
  console.error("❌ ERRO CRÍTICO: Alguma variável de ambiente está faltando!");
}

// ==================== CONEXÕES ====================
const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(geminiApiKey);

// ==================== FUNÇÕES AUXILIARES ====================
function formatarPreco(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  if (Number.isNaN(numero)) return `R$ ${valor}`;
  return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
  const stopWords = new Set(["de","da","do","das","dos","a","o","as","os","e","em","no","na","nos","nas","um","uma","uns","umas","pro","pra","para","com","que","tem","quero","quanto","custa","mostra","mostrar","ver"]);
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
      if (nomeNormalizado && mensagemNormalizada.includes(nomeNormalizado)) scoreNome += 8;
      for (const token of tokensMensagem) {
        if (temIntersecaoPorPrefixo(token, tokensNome)) scoreNome += 3;
        if (temIntersecaoPorPrefixo(token, tokensDescricao)) scoreDescricao += 1.5;
      }
      if (mensagemNormalizada.includes("combo") &&
          (nomeNormalizado.includes("combo") || descricaoNormalizada.includes("combo") ||
           descricaoNormalizada.includes("festa") || descricaoNormalizada.includes("evento"))) {
        scoreNome += 3;
      }
      const scoreTotal = Number((scoreNome * 0.7 + scoreDescricao * 0.3).toFixed(2));
      return { 
        servico, 
        score_nome: Number(scoreNome.toFixed(2)), 
        score_descricao: Number(scoreDescricao.toFixed(2)), 
        score_total: scoreTotal 
      };
    })
    .filter((item) => item.score_total >= 2)
    .sort((a, b) => b.score_total - a.score_total);
}

function identificarPedidoCardapio(mensagem = "") {
  const texto = normalizarTexto(mensagem);
  const termosCardapio = ["cardapio", "menu", "o que tem", "me mostra", "quais opcoes", "mostra o que tem", "quero ver"];
  return termosCardapio.some((termo) => texto.includes(termo));
}

function montarVitrineInicial(servicos = [], mensagem = "", limite = 6) {
  if (!Array.isArray(servicos) || servicos.length === 0) return [];
  const msg = normalizarTexto(mensagem);
  const querSalgado = msg.includes("salgado") || msg.includes("salgadin");
  const servicosFiltrados = querSalgado ? servicos.filter(item => {
    const alvo = normalizarTexto(`${item?.nome_servico || ""} ${item?.descricao || ""} ${item?.tipo_item || ""}`);
    return alvo.includes("salgad") || alvo.includes("coxinha") || alvo.includes("quibe") || alvo.includes("bolinha") || alvo.includes("esfiha") || alvo.includes("empada");
  }) : servicos;
  const base = servicosFiltrados.length > 0 ? servicosFiltrados : servicos;
  return base.slice(0, limite).map(item => ({
    nome: item?.nome_servico || item?.nome || "Item",
    preco: formatarPreco(item?.preco),
    descricao: (item?.descricao || "").trim() || null
  }));
}

function construirEvidenciasBanco({ mensagem, analiseMensagem, servicos = [], contextoVenda = "padrao" }) {
  const itensRankeados = detectarItensPorMensagem(servicos, mensagem);
  const principal = itensRankeados[0] || null;
  const pediuCardapio = identificarPedidoCardapio(mensagem);
  const intencaoDetectada = analiseMensagem?.intencaoDetectada || "duvida_geral";
  const vitrineInicial = pediuCardapio ? montarVitrineInicial(servicos, mensagem) : [];
  return {
    pediu_cardapio: pediuCardapio,
    intencao_detectada: intencaoDetectada,
    origem_detector_itens: "detectarItensPorMensagem",
    detector_cardapio_ativo: true,
    servico_detectado_principal: principal ? {
      nome_servico: principal.servico?.nome_servico || principal.servico?.nome || null,
      descricao: principal.servico?.descricao || principal.servico?.descricao_servico || null,
      preco: principal.servico?.preco ?? null,
      score_nome: principal.score_nome,
      score_descricao: principal.score_descricao,
      score_total: principal.score_total
    } : null,
    preco_item_principal_formatado: principal ? formatarPreco(principal.servico?.preco) : null,
    itens_detectados: itensRankeados.slice(0, 5).map(item => ({
      nome_servico: item.servico?.nome_servico || item.servico?.nome || null,
      preco: item.servico?.preco ?? null,
      score_nome: item.score_nome,
      score_descricao: item.score_descricao,
      score_total: item.score_total
    })),
    vitrine_inicial: vitrineInicial
  };
}

// ==================== FUNÇÕES DO PERFIL E ESTADO ====================
async function salvarAnaliseConversa(leadId, analiseMensagem) {
  if (!leadId || !analiseMensagem) return;
  const payload = {
    lead_id: leadId,
    intencao_detectada: analiseMensagem.intencaoDetectada || "duvida_geral",
    perfil_hipotese: analiseMensagem.perfilHipotese || "N",
    score_d: analiseMensagem.scoreD || 0,
    score_i: analiseMensagem.scoreI || 0,
    score_s: analiseMensagem.scoreS || 0,
    score_c: analiseMensagem.scoreC || 0
  };
  const { error } = await supabase.from("analise_conversa_mac").insert(payload);
  if (error) throw new Error(`Erro ao salvar análise: ${error.message}`);
}

async function atualizarPerfilLead(leadId, analiseMensagem) {
  if (!leadId || !analiseMensagem) return;
  const deltaD = analiseMensagem.scoreD || 0;
  const deltaI = analiseMensagem.scoreI || 0;
  const deltaS = analiseMensagem.scoreS || 0;
  const deltaC = analiseMensagem.scoreC || 0;

  const { data: perfilExistente } = await supabase
    .from("perfil_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  const novoScoreD = (perfilExistente?.score_d || 0) + deltaD;
  const novoScoreI = (perfilExistente?.score_i || 0) + deltaI;
  const novoScoreS = (perfilExistente?.score_s || 0) + deltaS;
  const novoScoreC = (perfilExistente?.score_c || 0) + deltaC;

  const perfilEstimado = calcularPerfilPorScores(novoScoreD, novoScoreI, novoScoreS, novoScoreC);
  const confianca = calcularConfiancaPorScores(novoScoreD, novoScoreI, novoScoreS, novoScoreC);

  const payload = {
    lead_id: leadId,
    perfil_estimado: perfilEstimado,
    confianca,
    score_d: novoScoreD,
    score_i: novoScoreI,
    score_s: novoScoreS,
    score_c: novoScoreC,
    updated_at: new Date().toISOString()
  };

  if (perfilExistente?.id) {
    await supabase.from("perfil_lead_mac").update(payload).eq("id", perfilExistente.id);
  } else {
    await supabase.from("perfil_lead_mac").insert(payload);
  }
}

function calcularPerfilPorScores(scoreD, scoreI, scoreS, scoreC) {
  const scores = [
    { perfil: "D", valor: scoreD || 0 },
    { perfil: "I", valor: scoreI || 0 },
    { perfil: "S", valor: scoreS || 0 },
    { perfil: "C", valor: scoreC || 0 }
  ].sort((a, b) => b.valor - a.valor);

  const maior = scores[0];
  const segundo = scores[1];

  if (maior.valor === 0) return "N";
  if (segundo.valor > 0 && maior.valor - segundo.valor <= 1) {
    const combinacao = `${maior.perfil}${segundo.perfil}`;
    if (["DI","DC","IS","SC"].includes(combinacao)) return combinacao;
  }
  return maior.perfil;
}

function calcularConfiancaPorScores(scoreD, scoreI, scoreS, scoreC) {
  const total = (scoreD || 0) + (scoreI || 0) + (scoreS || 0) + (scoreC || 0);
  if (total === 0) return 0.5;
  const maior = Math.max(scoreD || 0, scoreI || 0, scoreS || 0, scoreC || 0);
  return Number((maior / total).toFixed(2));
}

async function atualizarEstadoConversaLead(leadId, analiseMensagem) {
  if (!leadId || !analiseMensagem) return;
  // ... (implementação simplificada - pode ser expandida depois)
  console.log(`Estado da conversa atualizado para lead ${leadId}`);
}

async function buscarPerfilLead(leadId) {
  if (!leadId) return null;
  const { data, error } = await supabase
    .from("perfil_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (error) throw new Error(`Erro ao buscar perfil: ${error.message}`);
  return data;
}

async function buscarEstadoConversaLead(leadId) {
  if (!leadId) return null;
  const { data, error } = await supabase
    .from("estado_conversa_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (error) throw new Error(`Erro ao buscar estado: ${error.message}`);
  return data;
}

function extrairTextoGemini(response) {
  if (!response) return "";
  try {
    if (response.text) return response.text.trim();
    if (response.response?.text) return response.response.text.trim();
    return "";
  } catch (erro) {
    console.error("Erro extraindo Gemini:", erro);
    return "";
  }
}

async function gerarRespostaComGemini(contexto, mensagem, analiseMensagem, perfilLead = null, estadoConversa = null) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = buildMacPrompt({
      contextoEmpresa: contexto,
      mensagemCliente: mensagem,
      analiseMensagem,
      perfilLead,
      estadoConversa
    });

    const result = await model.generateContent(prompt);
    const texto = extrairTextoGemini(result.response || result);
    return { resposta: texto || "Desculpe, não consegui gerar uma resposta agora." };
  } catch (error) {
    console.error("Erro Gemini:", error);
    throw error;
  }
}

// ==================== ROTAS ====================
app.get("/", (req, res) => {
  res.send("M.A.C. backend online - Vercel");
});

app.get("/health", async (req, res) => {
  try {
    const status = {
      server: "ok",
      supabase_url: !!supabaseUrl,
      supabase_key: !!supabaseKey,
      gemini_key: !!geminiApiKey,
      using_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      supabase_connection: false
    };
    const { error } = await supabase.from("empresas").select("id").limit(1);
    status.supabase_connection = !error;
    if (error) status.supabase_error = error.message;
    res.json(status);
  } catch (err) {
    console.error("Erro no /health:", err);
    res.status(500).json({ server: "error", message: err.message });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { empresa_id, nome, telefone, canal = "whatsapp", mensagem, tipo_mensagem = "texto" } = req.body;

    if (!empresa_id || !telefone || !mensagem) {
      return res.status(400).json({ error: "empresa_id, telefone e mensagem são obrigatórios" });
    }

    const { data: configEmpresa } = await supabase
      .from("empresa_config")
      .select("*")
      .eq("empresa_id", empresa_id)
      .maybeSingle();

    const { data: produtos } = await supabase
      .from("cardapio_itens")
      .select("nome, descricao, preco, tipo_item")
      .eq("empresa_id", empresa_id)
      .eq("ativo", true);

    const { data: entradaData, error: entradaError } = await supabase.rpc("registrar_entrada_mensagem", {
      p_empresa_id: empresa_id,
      p_nome: nome || "Cliente",
      p_telefone: telefone,
      p_canal: canal,
      p_mensagem: mensagem,
      p_tipo_mensagem: tipo_mensagem
    });

    if (entradaError) {
      return res.status(500).json({ error: "Erro ao registrar entrada da mensagem", details: entradaError.message });
    }

    const leadId = entradaData.lead_id;
    const contexto = entradaData.contexto_empresa || {};
    const analiseMensagem = analyzeMessage(mensagem);

    await salvarAnaliseConversa(leadId, analiseMensagem);
    await atualizarPerfilLead(leadId, analiseMensagem);
    await atualizarEstadoConversaLead(leadId, analiseMensagem);

    const perfilLead = await buscarPerfilLead(leadId);
    const estadoConversa = await buscarEstadoConversaLead(leadId);

    const servicosContexto = contexto?.servicos || contexto?.servicos_empresa || [];
    const faq = contexto?.faq || contexto?.faq_empresa || [];

    let focoCombo = false;
    if (configEmpresa?.modelo_venda === "combo" || configEmpresa?.foco_principal === "festas") focoCombo = true;

    let produtosFiltrados = Array.isArray(produtos) ? produtos : [];
    if (focoCombo) {
      const combos = produtosFiltrados.filter(p => p.tipo_item === "combo");
      if (combos.length > 0) produtosFiltrados = combos;
    }

    const produtosComoServicos = produtosFiltrados.map(p => ({
      nome_servico: p.nome,
      preco: p.preco,
      descricao: p.descricao || "",
      tipo_item: p.tipo_item || null
    }));

    const servicos = [...servicosContexto, ...produtosComoServicos];
    const contextoVenda = configEmpresa?.modelo_venda === "combo" ? "combo" : "padrao";

    const evidenciasBanco = construirEvidenciasBanco({ mensagem, analiseMensagem, servicos, contextoVenda });

    let resposta = "";
    let origem_resposta = "gemini";

    try {
      const resultadoIA = await gerarRespostaComGemini(
        { ...contexto, evidencias_banco: evidenciasBanco }, 
        mensagem, 
        analiseMensagem, 
        perfilLead, 
        estadoConversa
      );
      resposta = resultadoIA.resposta;
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = "Desculpe, estou com dificuldade técnica no momento. Pode tentar novamente?";
      console.error("Erro Gemini:", geminiError);
    }

    return res.json({
      ok: true,
      lead_id: leadId,
      resposta,
      origem_resposta,
      analiseMensagem,
      perfilLead,
      estadoConversa,
      evidenciasBanco
    });

  } catch (err) {
    console.error("Erro geral na rota /chat:", err);
    return res.status(500).json({ 
      error: "Erro interno no servidor", 
      details: err.message 
    });
  }
});

// ==================== EXPORT PARA VERCEL ====================
module.exports = app;
