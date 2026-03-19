const cors = require("cors");
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");
const { buildMacPrompt } = require("./mac/macPromptBuilder");
const { analyzeMessage } = require("./mac/macAnalyzer");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const ai = new GoogleGenAI({
  apiKey: geminiApiKey
});

function formatarPreco(valor) {
  if (valor === null || valor === undefined || valor === "") {
    return null;
  }

  const numero = Number(valor);

  if (Number.isNaN(numero)) {
    return `R$ ${valor}`;
  }

  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
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
    "de",
    "da",
    "do",
    "das",
    "dos",
    "a",
    "o",
    "as",
    "os",
    "e",
    "em",
    "no",
    "na",
    "nos",
    "nas",
    "um",
    "uma",
    "uns",
    "umas",
    "pro",
    "pra",
    "para",
    "com",
    "que",
    "tem",
    "quero",
    "quanto",
    "custa",
    "mostra",
    "mostrar",
    "ver"
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
  if (!Array.isArray(servicos) || servicos.length === 0) {
    return [];
  }

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
        if (temIntersecaoPorPrefixo(token, tokensNome)) {
          scoreNome += 3;
        }

        if (temIntersecaoPorPrefixo(token, tokensDescricao)) {
          scoreDescricao += 1.5;
        }
      }

      if (
        mensagemNormalizada.includes("combo") &&
        (nomeNormalizado.includes("combo") ||
          descricaoNormalizada.includes("combo") ||
          descricaoNormalizada.includes("festa") ||
          descricaoNormalizada.includes("evento"))
      ) {
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
  const termosCardapio = [
    "cardapio",
    "menu",
    "o que tem",
    "me mostra",
    "quais opcoes",
    "mostra o que tem",
    "quero ver"
  ];

  return termosCardapio.some((termo) => texto.includes(termo));
}

function montarVitrineInicial(servicos = [], mensagem = "", limite = 6) {
  if (!Array.isArray(servicos) || servicos.length === 0) {
    return [];
  }

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
    descricao: (item?.descricao || "").trim() || null
  }));
}

function construirEvidenciasBanco({
  mensagem,
  analiseMensagem,
  servicos = [],
  contextoVenda = "padrao"
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
          score_total: principal.score_total
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
      score_total: item.score_total
    })),
    vitrine_inicial: vitrineInicial
  };
}

function encontrarServicoPorMensagem(
  servicos = [],
  mensagem = "",
  contextoVenda = "padrao"
) {
  if (!mensagem || !Array.isArray(servicos) || servicos.length === 0) {
    return null;
  }

  const itensRankeados = detectarItensPorMensagem(servicos, mensagem);
  const principal = itensRankeados[0];

  if (principal) {
    return principal.servico;
  }

  const msg = normalizarTexto(mensagem);

  if (contextoVenda === "combo") {
    const encontrouPorIntencaoCombo =
      msg.includes("combo") ||
      msg.includes("kit") ||
      msg.includes("festa") ||
      msg.includes("evento") ||
      msg.includes("anivers") ||
      msg.includes("encomenda") ||
      msg.includes("cento");

    if (encontrouPorIntencaoCombo) {
      return (
        servicos.find((servico) => {
          const nome = normalizarTexto(servico?.nome_servico || servico?.nome || "");
          const descricao = normalizarTexto(servico?.descricao || "");

          return (
            nome.includes("combo") ||
            descricao.includes("combo") ||
            descricao.includes("festa") ||
            descricao.includes("evento") ||
            descricao.includes("anivers") ||
            descricao.includes("encomenda") ||
            descricao.includes("cento")
          );
        }) || null
      );
    }
  }

  return null;
}

function validarRespostaMac(texto = "") {
  const resposta = (texto || "").replace(/\s+/g, " ").trim();

  if (!resposta) return false;
  if (resposta.length < 12) return false;

  const respostasGenericasRuins = [
    "Entendi. Me diga exatamente o que você procura.",
    "Entendi. Me diga exatamente o que você precisa.",
    "Posso te ajudar com isso.",
    "Me diga exatamente o que você precisa.",
    "Entendi. Posso te ajudar.",
    "Me diga o que você precisa.",
    "Entendi. Me diga qual serviço ou informação você quer saber.",
    "Me diga qual item ou serviço você quer consultar que eu te passo os valores."
  ];

  if (respostasGenericasRuins.some((r) => resposta.includes(r))) {
    return false;
  }

  const finaisValidos = [".", "!", "?", ".”", "!”", "?”"];
  const terminouBem = finaisValidos.some((final) => resposta.endsWith(final));

  if (!terminouBem) return false;

  const ultimaPalavra = resposta.split(" ").pop() || "";
  if (ultimaPalavra.length <= 2 && !/[.!?]$/.test(ultimaPalavra)) {
    return false;
  }

  return true;
}

function extrairTextoGemini(response) {
  if (!response) return "";

  try {
    if (typeof response.text === "string" && response.text.trim()) {
      return response.text.trim();
    }

    if (typeof response.text === "function") {
      const textoFn = response.text();
      if (typeof textoFn === "string" && textoFn.trim()) {
        return textoFn.trim();
      }
    }

    const candidates = response.candidates;

    if (Array.isArray(candidates) && candidates.length > 0) {
      const parts = candidates[0]?.content?.parts;

      if (Array.isArray(parts) && parts.length > 0) {
        const texto = parts
          .map((p) => p?.text || "")
          .join("")
          .trim();

        if (texto) {
          return texto;
        }
      }
    }

    return "";
  } catch (erro) {
    console.error("Erro extraindo resposta Gemini:", erro);
    return "";
  }
}

function criarRespostaFallback({
  mensagem,
  empresa,
  servicos = [],
  faq = [],
  analiseMensagem,
  perfilLead = null,
  estadoConversa = null,
  evidenciasBanco = null
}) {
  const msg = (mensagem || "").toLowerCase().trim();

  const nomeEmpresa = empresa?.nome || empresa?.nome_empresa || "nossa empresa";

  const perfil =
    perfilLead?.perfil_estimado || analiseMensagem?.perfilHipotese || "N";

  const intencao = analiseMensagem?.intencaoDetectada || "duvida_geral";
  const etapa = estadoConversa?.etapa_conversa || "aberta";
  const evidencias = evidenciasBanco || {};

  const saudacoes = [
    "oi",
    "olá",
    "ola",
    "bom dia",
    "boa tarde",
    "boa noite",
    "oii"
  ];

  return montarRespostaFallbackFactual({
    empresa,
    evidenciasBanco,
    mensagem,
    servicos,
    faq,
    analiseMensagem,
    perfilLead,
    estadoConversa
  });
}

  function montarRespostaFallbackFactual({ empresa = {}, evidenciasBanco = null }) {
    const nomeEmpresa = empresa?.nome || empresa?.nome_empresa || "empresa";
    const evidencias = evidenciasBanco || {};

    if (evidencias?.pediu_cardapio && Array.isArray(evidencias?.vitrine_inicial)) {
      const vitrine = evidencias.vitrine_inicial.slice(0, 6);

      if (vitrine.length > 0) {
        const itensTexto = vitrine
          .map((item) => {
            const nome = item?.nome_servico || item?.nome || "Item";
            const preco = formatarPreco(item?.preco) || item?.preco || "preço a confirmar";
            return `- ${nome}: ${preco}`;
          })
          .join("\n");

        return `Vitrine inicial da ${nomeEmpresa}:\n${itensTexto}`;
      }
    }

    const principal = evidencias?.servico_detectado_principal;
    if (principal?.nome_servico) {
      const nomeServico = principal.nome_servico;
      const precoFormatado =
        evidencias?.preco_item_principal_formatado || formatarPreco(principal.preco);
      const descricao = (principal.descricao || "").trim();

      if (precoFormatado && descricao) {
        return `Item detectado: ${nomeServico}. Preço: ${precoFormatado}. Descrição: ${descricao}`;
      }

      if (precoFormatado) {
        return `Item detectado: ${nomeServico}. Preço: ${precoFormatado}.`;
      }

      if (descricao) {
        return `Item detectado: ${nomeServico}. Descrição: ${descricao}`;
      }

      return `Item detectado: ${nomeServico}.`;
    }

    const itens = Array.isArray(evidencias?.itens_detectados)
      ? evidencias.itens_detectados.slice(0, 5)
      : [];

    if (itens.length > 0) {
      const itensTexto = itens
        .map((item) => {
          const nome = item?.nome_servico || "Item";
          const preco = formatarPreco(item?.preco) || "preço a confirmar";
          return `- ${nome}: ${preco}`;
        })
        .join("\n");

      return `Itens detectados:\n${itensTexto}`;
    }

    return "Não foi possível identificar item específico ou vitrine inicial com os dados atuais.";
  }

  function logObservabilidadeTemporaria({
    mensagem_recebida,
    intencao_detectada,
    itens_detectados,
    servico_detectado_principal,
    pediu_cardapio,
    origem_resposta
  }) {
    const payload = {
      mensagem_recebida: mensagem_recebida || "",
      intencao_detectada: intencao_detectada || "duvida_geral",
      itens_detectados: Array.isArray(itens_detectados) ? itens_detectados : [],
      servico_detectado_principal: servico_detectado_principal || null,
      pediu_cardapio: Boolean(pediu_cardapio),
      origem_resposta: origem_resposta || "indefinida"
    };

    console.log("[OBS_TEMP]", JSON.stringify(payload));
  }

  async function salvarAnaliseConversa(leadId, analiseMensagem) {
    if (!leadId || !analiseMensagem) return;

    const payload = {
      lead_id: leadId,
      intencao_detectada: analiseMensagem.intencaoDetectada || "duvida_geral",
      perfil_hipotese: analiseMensagem.perfilHipotese || "N",
      estrategia_resposta: analiseMensagem.estrategia || "resposta_equilibrada",
      score_d: analiseMensagem.scoreD || 0,
      score_i: analiseMensagem.scoreI || 0,
      score_s: analiseMensagem.scoreS || 0,
      score_c: analiseMensagem.scoreC || 0,
      objetividade: analiseMensagem.objetividade || "média",
      formalidade: analiseMensagem.formalidade || "média",
      energia: analiseMensagem.energia || "média",
      urgencia: analiseMensagem.urgencia || "baixa",
      texto_original: analiseMensagem.textoOriginal || "",
      tamanho_mensagem: analiseMensagem.tamanhoMensagem || 0,
      tem_girias: Boolean(analiseMensagem.temGirias),
      caixa_alta: Boolean(analiseMensagem.caixaAlta)
    };

    const { error } = await supabase.from("analise_conversa_mac").insert(payload);

  if (error) {
    throw new Error(`Erro ao salvar análise da conversa: ${error.message}`);
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

    if (combinacao === "ID") return "DI";
    if (combinacao === "CD") return "DC";
    if (combinacao === "SI") return "IS";
    if (combinacao === "CS") return "SC";
    if (["DI", "DC", "IS", "SC"].includes(combinacao)) return combinacao;
  }

  return maior.perfil;
}

function calcularEstrategiaPorPerfil(perfil) {
  if (perfil === "D") return "resposta_curta_direta";
  if (perfil === "I") return "resposta_amigavel_dinamica";
  if (perfil === "S") return "resposta_calma_acolhedora";
  if (perfil === "C") return "resposta_clara_detalhada";
  if (perfil === "DI") return "resposta_direta_com_energia";
  if (perfil === "DC") return "resposta_curta_clara";
  if (perfil === "IS") return "resposta_amigavel_empatica";
  if (perfil === "SC") return "resposta_segura_organizada";
  return "resposta_equilibrada";
}

function calcularConfiancaPorScores(scoreD, scoreI, scoreS, scoreC) {
  const total = (scoreD || 0) + (scoreI || 0) + (scoreS || 0) + (scoreC || 0);

  if (total === 0) return 0.5;

  const maior = Math.max(scoreD || 0, scoreI || 0, scoreS || 0, scoreC || 0);
  return Number((maior / total).toFixed(2));
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

  const perfilEstimado = calcularPerfilPorScores(
    novoScoreD,
    novoScoreI,
    novoScoreS,
    novoScoreC
  );

  const confianca = calcularConfiancaPorScores(
    novoScoreD,
    novoScoreI,
    novoScoreS,
    novoScoreC
  );

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
    await supabase
      .from("perfil_lead_mac")
      .update(payload)
      .eq("id", perfilExistente.id);
  } else {
    await supabase.from("perfil_lead_mac").insert(payload);
  }
}
  function mapearEstadoConversa(analiseMensagem) {
  const intencao = analiseMensagem?.intencaoDetectada || "duvida_geral";

  if (intencao === "orcamento") {
    return {
      etapa_conversa: "interesse",
      ultima_intencao: "orcamento",
      ultimo_assunto: "preco",
      precisa_followup: true,
      ultimo_objetivo: "informar_valor"
    };
  }

  if (intencao === "explicacao") {
    return {
      etapa_conversa: "consideracao",
      ultima_intencao: "explicacao",
      ultimo_assunto: "entendimento_servico",
      precisa_followup: true,
      ultimo_objetivo: "educar_cliente"
    };
  }

  if (intencao === "cardapio") {
    return {
      etapa_conversa: "interesse",
      ultima_intencao: "cardapio",
      ultimo_assunto: "vitrine_produtos",
      precisa_followup: true,
      ultimo_objetivo: "mostrar_opcoes"
    };
  }

  if (intencao === "disponibilidade") {
    return {
      etapa_conversa: "consideracao",
      ultima_intencao: "disponibilidade",
      ultimo_assunto: "horario",
      precisa_followup: true,
      ultimo_objetivo: "informar_disponibilidade"
    };
  }

  if (intencao === "agendamento") {
    return {
      etapa_conversa: "fechamento",
      ultima_intencao: "agendamento",
      ultimo_assunto: "marcacao",
      precisa_followup: false,
      ultimo_objetivo: "levar_para_marcacao"
    };
  }

  return {
    etapa_conversa: "aberta",
    ultima_intencao: intencao,
    ultimo_assunto: "duvida_geral",
    precisa_followup: false,
    ultimo_objetivo: "manter_conversa"
  };
}

async function atualizarEstadoConversaLead(leadId, analiseMensagem) {
  if (!leadId || !analiseMensagem) return;

  const estadoMapeado = mapearEstadoConversa(analiseMensagem);

  const { data: estadoExistente, error: estadoError } = await supabase
    .from("estado_conversa_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (estadoError) {
    throw new Error(`Erro ao buscar estado da conversa: ${estadoError.message}`);
  }

  const payload = {
    lead_id: leadId,
    etapa_conversa: estadoMapeado.etapa_conversa,
    ultima_intencao: estadoMapeado.ultima_intencao,
    ultimo_assunto: estadoMapeado.ultimo_assunto,
    precisa_followup: estadoMapeado.precisa_followup,
    ultimo_objetivo: estadoMapeado.ultimo_objetivo,
    updated_at: new Date().toISOString()
  };

  if (estadoExistente?.id) {
    const { error: updateError } = await supabase
      .from("estado_conversa_lead_mac")
      .update(payload)
      .eq("id", estadoExistente.id);

    if (updateError) {
      throw new Error(`Erro ao atualizar estado da conversa: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await supabase
      .from("estado_conversa_lead_mac")
      .insert(payload);

    if (insertError) {
      throw new Error(`Erro ao criar estado da conversa: ${insertError.message}`);
    }
  }
}

async function buscarEstadoConversaLead(leadId) {
  if (!leadId) return null;

  const { data, error } = await supabase
    .from("estado_conversa_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar estado da conversa: ${error.message}`);
  }

  return data || null;
}

async function buscarPerfilLead(leadId) {
  if (!leadId) return null;

  const { data, error } = await supabase
    .from("perfil_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (error) {
    throw new Error(`Erro ao buscar perfil do lead: ${error.message}`);
  }

  return data || null;
}

async function gerarRespostaComGemini(
  contexto,
  mensagem,
  analiseMensagem,
  perfilLead = null,
  estadoConversa = null,
  evidenciasBanco = null
) {
  try {
    const prompt = buildMacPrompt({
      contextoEmpresa: contexto,
      mensagemCliente: mensagem,
      analiseMensagem,
      perfilLead,
      estadoConversa,
      evidenciasBanco
    });

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 0.6,
        topP: 0.9,
        maxOutputTokens: 1500
      }
    });

    const texto = extrairTextoGemini(response);

    return {
      resposta: texto || "Desculpe, não consegui gerar uma resposta agora."
    };
  } catch (error) {
    console.error("Erro Gemini:", error);
    throw error;
  }
}

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
      using_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      supabase_connection: false
    };

    const { error } = await supabase.from("empresas").select("id").limit(1);
    status.supabase_connection = !error;

    if (error) {
      status.supabase_error = error.message;
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({
      server: "error",
      message: err.message
    });
  }
});

app.get("/teste", async (req, res) => {
  try {
    const mensagem = "Oi, queria saber o valor da limpeza de pele";

    const { data: entradaData, error: entradaError } = await supabase.rpc(
      "registrar_entrada_mensagem",
      {
        p_empresa_id: 1,
        p_nome: "Carlos",
        p_telefone: "31999999999",
        p_canal: "whatsapp",
        p_mensagem: mensagem,
        p_tipo_mensagem: "texto"
      }
    );

    if (entradaError) {
      return res.status(500).json({
        error: "Erro ao registrar entrada da mensagem",
        details: entradaError.message
      });
    }

    const contexto = entradaData.contexto_empresa || {};
    const leadId = entradaData.lead_id;
    const analiseMensagem = analyzeMessage(mensagem);

    await salvarAnaliseConversa(leadId, analiseMensagem);
    await atualizarPerfilLead(leadId, analiseMensagem);
    await atualizarEstadoConversaLead(leadId, analiseMensagem);

    const perfilLead = await buscarPerfilLead(leadId);
    const estadoConversa = await buscarEstadoConversaLead(leadId);

    const servicos = contexto?.servicos || contexto?.servicos_empresa || [];
    const faq = contexto?.faq || contexto?.faq_empresa || [];
    const evidenciasBanco = construirEvidenciasBanco({
      mensagem,
      analiseMensagem,
      servicos,
      contextoVenda: "padrao"
    });

    let resposta = "";
    let origem_resposta = "gemini";

    if (!resposta) {
      try {
        const resultadoIA = await gerarRespostaComGemini(
          contexto,
          mensagem,
          analiseMensagem,
          perfilLead,
          estadoConversa,
          evidenciasBanco
        );

        resposta = resultadoIA.resposta;

        if (!validarRespostaMac(resposta)) {
          throw new Error("Resposta do Gemini inválida ou genérica");
        }
      } catch (geminiError) {
        origem_resposta = "fallback";
        resposta = criarRespostaFallback({
          mensagem,
          empresa: contexto?.empresa || {},
          servicos,
          faq,
          analiseMensagem,
          perfilLead,
          estadoConversa,
          evidenciasBanco
        });
        console.error("Erro Gemini /teste:", geminiError);
      }
    }

    logObservabilidadeTemporaria({
      mensagem_recebida: mensagem,
      intencao_detectada: analiseMensagem?.intencaoDetectada,
      itens_detectados: evidenciasBanco?.itens_detectados,
      servico_detectado_principal: evidenciasBanco?.servico_detectado_principal,
      pediu_cardapio: evidenciasBanco?.pediu_cardapio,
      origem_resposta
    });

    const { error: respostaError } = await supabase.rpc(
      "registrar_resposta_mac",
      {
        p_lead_id: leadId,
        p_resposta: resposta,
        p_tipo_mensagem: "texto"
      }
    );

    if (respostaError) {
      return res.status(500).json({
        error: "Erro ao salvar resposta do M.A.C.",
        details: respostaError.message
      });
    }

    return res.json({
      ok: true,
      lead_id: leadId,
      pergunta: mensagem,
      resposta,
      origem_resposta,
      evidenciasBanco,
      analiseMensagem,
      perfilLead,
      estadoConversa
    });
  } catch (err) {
    return res.status(500).json({
      error: "Erro interno no /teste",
      details: err.message
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const {
      empresa_id,
      nome,
      telefone,
      canal = "whatsapp",
      mensagem,
      tipo_mensagem = "texto"
    } = req.body;

    const { data: configEmpresa, error: erroConfig } = await supabase
      .from("empresa_config")
      .select("*")
      .eq("empresa_id", empresa_id)
      .maybeSingle();

    if (erroConfig) {
      console.log("ERRO AO BUSCAR CONFIG:", erroConfig);
    }

    console.log("CONFIG EMPRESA:", configEmpresa);

    if (!empresa_id || !telefone || !mensagem) {
      return res.status(400).json({
        error: "empresa_id, telefone e mensagem são obrigatórios"
      });
    }

    const { data: produtos, error: produtosError } = await supabase
      .from("cardapio_itens")
      .select("nome, descricao, preco, tipo_item")
      .eq("empresa_id", empresa_id)
      .eq("ativo", true);

    if (produtosError) {
      console.error("Erro ao buscar cardápio:", produtosError.message);
    }

    const { data: entradaData, error: entradaError } = await supabase.rpc(
      "registrar_entrada_mensagem",
      {
        p_empresa_id: empresa_id,
        p_nome: nome || "Cliente",
        p_telefone: telefone,
        p_canal: canal,
        p_mensagem: mensagem,
        p_tipo_mensagem: tipo_mensagem
      }
    );

    if (entradaError) {
      return res.status(500).json({
        error: "Erro ao registrar entrada da mensagem",
        details: entradaError.message
      });
    }

    const leadId = entradaData.lead_id;
    const contexto = entradaData.contexto_empresa || {};
    const analiseMensagem = analyzeMessage(mensagem);

    await salvarAnaliseConversa(leadId, analiseMensagem);
    await atualizarPerfilLead(leadId, analiseMensagem);
    await atualizarEstadoConversaLead(leadId, analiseMensagem);

    const perfilLead = await buscarPerfilLead(leadId);
    const estadoConversa = await buscarEstadoConversaLead(leadId);

    const servicos = contexto?.servicos || contexto?.servicos_empresa || [];
    const faq = contexto?.faq || contexto?.faq_empresa || [];

    let focoCombo = false;

    if (
      configEmpresa?.modelo_venda === "combo" ||
      configEmpresa?.foco_principal === "festas"
    ) {
      focoCombo = true;
    }

    let produtosFiltrados = produtos || [];

    if (focoCombo) {
      const combos = produtosFiltrados.filter((p) => p.tipo_item === "combo");

      if (combos.length > 0) {
        produtosFiltrados = combos;
      }
    }

    if (produtosFiltrados.length > 0) {
      const produtosComoServicos = produtosFiltrados.map((p) => ({
        nome_servico: p.nome,
        preco: p.preco,
        descricao: p.descricao || "",
        tipo_item: p.tipo_item || null
      }));

      servicos.push(...produtosComoServicos);
    }

    let contextoVenda = "padrao";

    if (configEmpresa?.modelo_venda === "combo") {
      contextoVenda = "combo";
    }

    if (configEmpresa?.modelo_venda === "servico") {
      contextoVenda = "servico";
    }

    const evidenciasBanco = construirEvidenciasBanco({
      mensagem,
      analiseMensagem,
      servicos,
      contextoVenda
    });

    let resposta = "";
    let origem_resposta = "gemini";

    if (!resposta) {
      try {
        const resultadoIA = await gerarRespostaComGemini(
          contexto,
          mensagem,
          analiseMensagem,
          perfilLead,
          estadoConversa,
          evidenciasBanco
        );

        resposta = resultadoIA.resposta;

        if (!validarRespostaMac(resposta)) {
          throw new Error("Resposta do Gemini inválida ou genérica");
        }
      } catch (geminiError) {
        origem_resposta = "fallback";

        resposta = criarRespostaFallback({
          mensagem,
          empresa: contexto?.empresa || {},
          servicos,
          faq,
          analiseMensagem,
          perfilLead,
          estadoConversa,
          evidenciasBanco
        });

        console.error("Erro Gemini /chat:", geminiError);
      }
    }

    logObservabilidadeTemporaria({
      mensagem_recebida: mensagem,
      intencao_detectada: analiseMensagem?.intencaoDetectada,
      itens_detectados: evidenciasBanco?.itens_detectados,
      servico_detectado_principal: evidenciasBanco?.servico_detectado_principal,
      pediu_cardapio: evidenciasBanco?.pediu_cardapio,
      origem_resposta
    });

    const { error: respostaError } = await supabase.rpc(
      "registrar_resposta_mac",
      {
        p_lead_id: leadId,
        p_resposta: resposta,
        p_tipo_mensagem: tipo_mensagem
      }
    );

    if (respostaError) {
      return res.status(500).json({
        error: "Erro ao salvar resposta do M.A.C.",
        details: respostaError.message
      });
    }

    return res.json({
      ok: true,
      lead_id: leadId,
      resposta,
      origem_resposta,
      evidenciasBanco,
      analiseMensagem,
      perfilLead,
      estadoConversa
    });
  } catch (err) {
    return res.status(500).json({
      error: "Erro interno no /chat",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`M.A.C. backend rodando na porta ${PORT}`);
});
