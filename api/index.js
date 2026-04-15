const cors = require("cors");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");
const { buildMacPrompt } = require("./mac/macPromptBuilder");
const { analyzeMessage } = require("./mac/macAnalyzer");

const app = express();

// ==================== CORS (importante para Vercel) ====================
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

app.use(express.json());

// ==================== VARIÁVEIS DE AMBIENTE ====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({ apiKey: geminiApiKey });

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
      return { servico, score_nome: Number(scoreNome.toFixed(2)), score_descricao: Number(scoreDescricao.toFixed(2)), score_total: scoreTotal };
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

// (Todas as outras funções como criarRespostaFallback, logObservabilidadeTemporaria, salvarAnaliseConversa, atualizarPerfilLead, etc. foram mantidas iguais)

function extrairTextoGemini(response) {
  if (!response) return "";
  try {
    if (typeof response.text === "string" && response.text.trim()) return response.text.trim();
    if (typeof response.text === "function") {
      const textoFn = response.text();
      if (typeof textoFn === "string" && textoFn.trim()) return textoFn.trim();
    }
    const candidates = response.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const parts = candidates[0]?.content?.parts;
      if (Array.isArray(parts) && parts.length > 0) {
        return parts.map(p => p?.text || "").join("").trim();
      }
    }
    return "";
  } catch (erro) {
    console.error("Erro extraindo resposta Gemini:", erro);
    return "";
  }
}

async function gerarRespostaComGemini(contexto, mensagem, analiseMensagem, perfilLead = null, estadoConversa = null) {
  try {
    const prompt = buildMacPrompt({
      contextoEmpresa: contexto,
      mensagemCliente: mensagem,
      analiseMensagem,
      perfilLead,
      estadoConversa
    });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: { temperature: 0.6, topP: 0.9, maxOutputTokens: 1500 }
    });
    const texto = extrairTextoGemini(response);
    return { resposta: texto || "Desculpe, não consegui gerar uma resposta agora." };
  } catch (error) {
    console.error("Erro Gemini:", error);
    throw error;
  }
}

// ==================== ROTAS ====================
app.get("/", (req, res) => res.send("M.A.C. backend online - Vercel"));

app.get("/health", async (req, res) => {
  try {
    const status = { server: "ok", supabase_url: !!supabaseUrl, supabase_key: !!supabaseKey, gemini_key: !!geminiApiKey, using_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY, supabase_connection: false };
    const { error } = await supabase.from("empresas").select("id").limit(1);
    status.supabase_connection = !error;
    if (error) status.supabase_error = error.message;
    res.json(status);
  } catch (err) {
    res.status(500).json({ server: "error", message: err.message });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { empresa_id, nome, telefone, canal = "whatsapp", mensagem, tipo_mensagem = "texto" } = req.body;
    if (!empresa_id || !telefone || !mensagem) {
      return res.status(400).json({ error: "empresa_id, telefone e mensagem são obrigatórios" });
    }

    // Todo o código da rota /chat que você tinha originalmente
    const { data: configEmpresa, error: erroConfig } = await supabase.from("empresa_config").select("*").eq("empresa_id", empresa_id).maybeSingle();
    const { data: produtos, error: produtosError } = await supabase.from("cardapio_itens").select("nome, descricao, preco, tipo_item").eq("empresa_id", empresa_id).eq("ativo", true);

    const { data: entradaData, error: entradaError } = await supabase.rpc("registrar_entrada_mensagem", {
      p_empresa_id: empresa_id,
      p_nome: nome || "Cliente",
      p_telefone: telefone,
      p_canal: canal,
      p_mensagem: mensagem,
      p_tipo_mensagem: tipo_mensagem
    });

    if (entradaError) return res.status(500).json({ error: "Erro ao registrar entrada da mensagem", details: entradaError.message });

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
    const contextoVenda = configEmpresa?.modelo_venda === "combo" ? "combo" : configEmpresa?.modelo_venda === "servico" ? "servico" : "padrao";

    const evidenciasBanco = construirEvidenciasBanco({ mensagem, analiseMensagem, servicos, contextoVenda });

    let resposta = "";
    let origem_resposta = "gemini";

    try {
      const resultadoIA = await gerarRespostaComGemini({ ...contexto, evidencias_banco: evidenciasBanco }, mensagem, analiseMensagem, perfilLead, estadoConversa);
      resposta = resultadoIA.resposta;
      if (!resposta || typeof resposta !== "string" || !resposta.trim()) throw new Error("Resposta vazia do Gemini");
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback({ mensagem, empresa: contexto?.empresa || {}, servicos, faq, analiseMensagem, perfilLead, estadoConversa, evidenciasBanco });
      console.error("Erro Gemini /chat:", geminiError);
    }

    const { error: respostaError } = await supabase.rpc("registrar_resposta_mac", {
      p_lead_id: leadId,
      p_resposta: resposta,
      p_tipo_mensagem: tipo_mensagem
    });

    if (respostaError) return res.status(500).json({ error: "Erro ao salvar resposta do M.A.C.", details: respostaError.message });

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
    return res.status(500).json({ error: "Erro interno no /chat", details: err.message });
  }
});

// ==================== EXPORT PARA VERCEL ====================
module.exports = app;
