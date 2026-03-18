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
  return String(texto)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizarTexto(texto = "") {
  return normalizarTexto(texto)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function encontrarServicosPorMensagem(servicos = [], mensagem = "") {
  const msgNormalizada = normalizarTexto(mensagem);
  const tokensMensagem = tokenizarTexto(mensagem);

  if (!msgNormalizada || !Array.isArray(servicos) || servicos.length === 0) {
    return [];
  }

  const resultados = servicos
    .map((servico) => {
      const nome = normalizarTexto(servico?.nome_servico || "");
      const descricao = normalizarTexto(servico?.descricao || "");

      if (!nome && !descricao) return null;

      let score = 0;

      if (nome && msgNormalizada.includes(nome)) score += 10;
      if (nome && nome.includes(msgNormalizada) && msgNormalizada.length >= 4) {
        score += 6;
      }

      for (const token of tokensMensagem) {
        if (nome.includes(token)) score += 3;
        if (descricao.includes(token)) score += 1;
      }

      const termosFortes = [
        "combo",
        "combos",
        "coxinha",
        "coxinhas",
        "bolinha",
        "bolinhas",
        "queijo",
        "risole",
        "risoles",
        "risoli",
        "pastel",
        "pasteis",
        "pastéis",
        "milho",
        "bolo",
        "bolinho",
        "bolinhos",
        "cenoura",
        "salgado",
        "salgados",
        "salgadinho",
        "salgadinhos"
      ];

      for (const termo of termosFortes) {
        if (msgNormalizada.includes(termo) && nome.includes(termo)) score += 4;
        if (msgNormalizada.includes(termo) && descricao.includes(termo)) {
          score += 2;
        }
      }

      if (score <= 0) return null;

      return {
        ...servico,
        _score: score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b._score - a._score);

  return resultados;
}

function deduplicarServicos(servicos = []) {
  const mapa = new Map();

  for (const servico of servicos) {
    const chave = normalizarTexto(servico?.nome_servico || "");
    if (!chave) continue;

    if (!mapa.has(chave)) {
      mapa.set(chave, servico);
    }
  }

  return Array.from(mapa.values());
}

function construirEvidenciasBanco(servicos = [], mensagem = "", analiseMensagem = null) {
  const msgLower = normalizarTexto(mensagem);
  const servicosDetectados = encontrarServicosPorMensagem(servicos, mensagem);
  const servicoDetectado = servicosDetectados[0] || null;

  const pediuCardapio =
    msgLower.includes("cardapio") ||
    msgLower.includes("menu") ||
    msgLower.includes("mostra") ||
    msgLower.includes("mostrar") ||
    msgLower.includes("quero ver") ||
    msgLower.includes("opcoes") ||
    msgLower.includes("opcao") ||
    msgLower.includes("combo") ||
    msgLower.includes("combos") ||
    msgLower.includes("salgado") ||
    msgLower.includes("salgados") ||
    msgLower.includes("salgadinho") ||
    msgLower.includes("salgadinhos");

  return {
    pediu_cardapio: pediuCardapio,
    intencao_detectada: analiseMensagem?.intencaoDetectada || null,
    servico_detectado_principal: servicoDetectado
      ? {
          nome_servico: servicoDetectado.nome_servico,
          descricao: servicoDetectado.descricao || "",
          preco: servicoDetectado.preco ?? null
        }
      : null,
    itens_detectados: servicosDetectados.slice(0, 5).map((s) => ({
      nome_servico: s.nome_servico,
      descricao: s.descricao || "",
      preco: s.preco ?? null
    })),
    vitrine_inicial: servicos.slice(0, 8).map((s) => ({
      nome_servico: s.nome_servico,
      descricao: s.descricao || "",
      preco: s.preco ?? null
    }))
  };
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
  estadoConversa = null
}) {
  const msg = (mensagem || "").toLowerCase().trim();
  const evidenciasBanco = empresa?.evidencias_banco || null;

  const nomeEmpresa = empresa?.nome || empresa?.nome_empresa || "nossa empresa";

  const perfil =
    perfilLead?.perfil_estimado || analiseMensagem?.perfilHipotese || "N";

  const intencao = analiseMensagem?.intencaoDetectada || "duvida_geral";
  const etapa = estadoConversa?.etapa_conversa || "aberta";

  const saudacoes = [
    "oi",
    "olá",
    "ola",
    "bom dia",
    "boa tarde",
    "boa noite",
    "oii",
    "eai",
    "e aí"
  ];

  function modularTexto({ neutra, direta, acolhedora, calorosa }) {
    if (perfil === "D" || perfil === "DC" || perfil === "DI") {
      return direta || neutra;
    }

    if (perfil === "C" || perfil === "SC") {
      return neutra;
    }

    if (perfil === "S" || perfil === "IS") {
      return acolhedora || neutra;
    }

    if (perfil === "I") {
      return calorosa || acolhedora || neutra;
    }

    return neutra;
  }

  const ehSaudacao =
    saudacoes.some((s) => msg === s || msg.startsWith(`${s} `)) &&
    msg.split(/\s+/).length <= 5;

  if (ehSaudacao) {
    return modularTexto({
      neutra: "Olá! Como posso te ajudar?",
      direta: "Olá! Como posso te ajudar?",
      acolhedora: "Olá! 😊 Como posso te ajudar?",
      calorosa: "Oi! 😊 Como posso te ajudar hoje?"
    });
  }

  if (
    evidenciasBanco?.pediu_cardapio &&
    Array.isArray(evidenciasBanco?.vitrine_inicial) &&
    evidenciasBanco.vitrine_inicial.length > 0
  ) {
    const itens = evidenciasBanco.vitrine_inicial
      .slice(0, 8)
      .map((item) => {
        const preco = formatarPreco(item.preco);
        return `• ${item.nome_servico}${preco ? ` — ${preco}` : ""}`;
      })
      .join("\n");

    return `Claro! Aqui estão algumas opções do nosso cardápio:\n\n${itens}\n\nSe quiser, eu também posso te mostrar só os combos ou só os salgados.`;
  }

  if (evidenciasBanco?.servico_detectado_principal) {
    const item = evidenciasBanco.servico_detectado_principal;
    const preco = formatarPreco(item.preco);

    return `${item.nome_servico}${preco ? ` custa ${preco}.` : "."}${
      item.descricao ? ` ${item.descricao}` : ""
    }`;
  }

  const servicosDetectados = encontrarServicosPorMensagem(servicos, mensagem);
  const servicoEncontrado = servicosDetectados[0] || null;

  if (servicoEncontrado) {
    const nomeServico = servicoEncontrado.nome_servico || "esse serviço";
    const descricao =
      servicoEncontrado.descricao ||
      servicoEncontrado.descricao_servico ||
      null;
    const precoFormatado = formatarPreco(servicoEncontrado.preco);

    if (intencao === "orcamento" && precoFormatado) {
      return modularTexto({
        neutra: `${nomeServico} custa ${precoFormatado}. Se quiser, também posso te explicar como funciona.`,
        direta: `${nomeServico} custa ${precoFormatado}. Se quiser, já te explico o próximo passo.`,
        acolhedora: `${nomeServico} custa ${precoFormatado}. 😊 Se quiser, também posso te explicar direitinho como funciona.`,
        calorosa: `${nomeServico} custa ${precoFormatado}. 😊 Se quiser, eu também posso te explicar como funciona ou te ajudar com o próximo passo.`
      });
    }

    if (
      intencao === "explicacao" ||
      msg.includes("fazem") ||
      msg.includes("tem ") ||
      msg.includes("vocês fazem") ||
      msg.includes("voces fazem")
    ) {
      if (descricao) {
        return modularTexto({
          neutra: `Sim, fazemos ${nomeServico}. ${descricao} Se quiser, também posso te passar o valor.`,
          direta: `Sim, fazemos ${nomeServico}. ${descricao} Se quiser, já te passo o valor.`,
          acolhedora: `Sim, fazemos ${nomeServico}. ${descricao} Se quiser, também posso te passar o valor 😊`,
          calorosa: `Sim! Fazemos ${nomeServico}. ${descricao} Se quiser, eu também posso te passar o valor 😊`
        });
      }

      return modularTexto({
        neutra: `Sim, fazemos ${nomeServico}. Se quiser, posso te explicar melhor como funciona ou te passar o valor.`,
        direta: `Sim, fazemos ${nomeServico}. Se quiser, já te passo o valor.`,
        acolhedora: `Sim, fazemos ${nomeServico}. Se quiser, posso te explicar melhor como funciona ou te passar o valor 😊`,
        calorosa: `Sim! Fazemos ${nomeServico}. Se quiser, eu também posso te explicar como funciona ou te passar o valor 😊`
      });
    }

    if (descricao) {
      return modularTexto({
        neutra: `${nomeServico} é um serviço que oferecemos na ${nomeEmpresa}. ${descricao}`,
        direta: `${nomeServico} está disponível na ${nomeEmpresa}. ${descricao}`,
        acolhedora: `${nomeServico} é um dos serviços que oferecemos na ${nomeEmpresa}. ${descricao}`,
        calorosa: `${nomeServico} está disponível por aqui na ${nomeEmpresa}. ${descricao}`
      });
    }
  }

  const faqEncontrada = Array.isArray(faq)
    ? faq.find((item) => {
        const pergunta = (item?.pergunta || "").toLowerCase().trim();
        if (!pergunta) return false;
        return msg.includes(pergunta.replace("?", ""));
      })
    : null;

  if (faqEncontrada?.resposta) {
    return faqEncontrada.resposta;
  }

  if (
    msg.includes("cardápio") ||
    msg.includes("cardapio") ||
    msg.includes("menu")
  ) {
    return modularTexto({
      neutra: `Claro! Posso te mostrar o que temos disponível na ${nomeEmpresa}. Você quer algo para agora ou está buscando alguma opção específica?`,
      direta: `Temos opções disponíveis na ${nomeEmpresa}. Você quer algo para agora ou alguma opção específica?`,
      acolhedora: `Claro! 😊 Posso te mostrar o que temos disponível na ${nomeEmpresa}. Você quer algo para agora ou alguma opção específica?`,
      calorosa: `Claro! 😊 Posso te mostrar o que temos disponível por aqui na ${nomeEmpresa}. Você quer algo para agora ou alguma opção específica?`
    });
  }

  if (
    msg.includes("encomenda") ||
    msg.includes("festa") ||
    msg.includes("anivers") ||
    msg.includes("evento") ||
    msg.includes("cento")
  ) {
    return modularTexto({
      neutra:
        "Perfeito. Me diga para quantas pessoas é a encomenda ou o que você tem em mente que eu te ajudo.",
      direta:
        "Certo. Me diga a quantidade ou para quantas pessoas é a encomenda.",
      acolhedora:
        "Perfeito 😊 Me diga para quantas pessoas é a encomenda ou o que você tem em mente que eu te ajudo.",
      calorosa:
        "Perfeito! 😊 Me diga para quantas pessoas é a encomenda ou o que você gostaria de pedir."
    });
  }

  if (
    msg.includes("preço") ||
    msg.includes("preco") ||
    msg.includes("valor") ||
    msg.includes("quanto custa") ||
    intencao === "orcamento"
  ) {
    return modularTexto({
      neutra: `Posso te ajudar com os valores aqui na ${nomeEmpresa}. Me diga qual item ou serviço você quer consultar.`,
      direta:
        "Me diga qual item ou serviço você quer consultar que eu te passo os valores.",
      acolhedora:
        `Claro 😊 Posso te ajudar com os valores. Me diga qual item ou serviço você quer consultar.`,
      calorosa:
        `Claro! 😊 Me diga qual item ou serviço você quer consultar que eu te ajudo com os valores.`
    });
  }

  if (
    msg.includes("agendar") ||
    msg.includes("horário") ||
    msg.includes("horario") ||
    msg.includes("marcar") ||
    intencao === "agendamento"
  ) {
    return modularTexto({
      neutra:
        "Posso te ajudar com isso. Me diga qual dia, horário ou serviço você tem em mente.",
      direta: "Me diga o dia, horário ou serviço que você quer.",
      acolhedora:
        "Claro 😊 Posso te ajudar com isso. Me diga qual dia, horário ou serviço você está buscando.",
      calorosa:
        "Claro! 😊 Me diga qual dia, horário ou serviço você tem em mente que eu te ajudo."
    });
  }

  if (etapa === "fechamento") {
    return modularTexto({
      neutra:
        "Certo. Me diga só o que falta para eu te ajudar a concluir isso da melhor forma.",
      direta: "Certo. Me diga o que falta para concluir.",
      acolhedora:
        "Certo 😊 Me diga só o que falta para eu te ajudar a concluir isso com tranquilidade.",
      calorosa:
        "Certo! 😊 Me conta o que falta que eu te ajudo a concluir isso."
    });
  }

  if (etapa === "interesse" || etapa === "consideracao") {
    return modularTexto({
      neutra: `Entendi. Me fala qual serviço, produto ou informação você quer saber na ${nomeEmpresa} que eu te respondo de forma mais direta.`,
      direta: "Entendi. Me diga qual serviço ou informação você quer saber.",
      acolhedora: `Entendi 😊 Me fala qual serviço, produto ou informação você quer saber na ${nomeEmpresa} que eu te respondo direitinho.`,
      calorosa: `Entendi! 😊 Me conta o que você quer saber na ${nomeEmpresa} que eu te ajudo por aqui.`
    });
  }

  return modularTexto({
    neutra: `Entendi. Posso te ajudar aqui na ${nomeEmpresa}. Me diga um pouco melhor o que você precisa.`,
    direta: "Entendi. Me diga exatamente o que você precisa.",
    acolhedora: `Entendi 😊 Me diga um pouco melhor o que você precisa, que eu te ajudo da melhor forma.`,
    calorosa: `Entendi! 😊 Me conta melhor o que você precisa que eu te ajudo.`
  });
}

async function salvarAnaliseConversa(leadId, analiseMensagem) {
  if (!leadId || !analiseMensagem) return;

  const payload = {
    lead_id: leadId,
    mensagem_original: analiseMensagem.textoOriginal || null,
    tamanho_mensagem: analiseMensagem.tamanhoMensagem || null,
    objetividade: analiseMensagem.objetividade || null,
    formalidade: analiseMensagem.formalidade || null,
    energia: analiseMensagem.energia || null,
    urgencia: analiseMensagem.urgencia || null,
    intencao_detectada: analiseMensagem.intencaoDetectada || null,
    tem_girias: analiseMensagem.temGirias ?? null,
    caixa_alta: analiseMensagem.caixaAlta ?? null,
    perfil_hipotese: analiseMensagem.perfilHipotese || null,
    estrategia: analiseMensagem.estrategia || null,
    score_d: analiseMensagem.scoreD || 0,
    score_i: analiseMensagem.scoreI || 0,
    score_s: analiseMensagem.scoreS || 0,
    score_c: analiseMensagem.scoreC || 0
  };

  const { error } = await supabase
    .from("analise_conversa_mac")
    .insert(payload);

  if (error) {
    throw new Error(`Erro ao salvar análise da conversa: ${error.message}`);
  }
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
  estadoConversa = null
) {
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

    const servicosBase = contexto?.servicos || contexto?.servicos_empresa || [];
    const faq = contexto?.faq || contexto?.faq_empresa || [];
    const servicos = deduplicarServicos(servicosBase);

    const evidenciasBanco = construirEvidenciasBanco(
      servicos,
      mensagem,
      analiseMensagem
    );

    let resposta = "";
    let origem_resposta = "gemini";

    try {
      const resultadoIA = await gerarRespostaComGemini(
        {
          ...contexto,
          evidencias_banco: evidenciasBanco
        },
        mensagem,
        analiseMensagem,
        perfilLead,
        estadoConversa
      );

      resposta = resultadoIA.resposta;

      if (!resposta || typeof resposta !== "string" || !resposta.trim()) {
        throw new Error("Resposta vazia do Gemini");
      }
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback({
        mensagem,
        empresa: {
          ...(contexto?.empresa || {}),
          evidencias_banco: evidenciasBanco
        },
        servicos,
        faq,
        analiseMensagem,
        perfilLead,
        estadoConversa
      });
      console.error("Erro Gemini /teste:", geminiError);
    }

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
      analiseMensagem,
      perfilLead,
      estadoConversa,
      evidenciasBanco
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

    const servicosContexto = contexto?.servicos || contexto?.servicos_empresa || [];
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

    const produtosComoServicos = produtosFiltrados.map((p) => ({
      nome_servico: p.nome,
      preco: p.preco,
      descricao: p.descricao || ""
    }));

    const servicos = deduplicarServicos([
      ...servicosContexto,
      ...produtosComoServicos
    ]);

    const evidenciasBanco = construirEvidenciasBanco(
      servicos,
      mensagem,
      analiseMensagem
    );

    console.log("Mensagem:", mensagem);
    console.log("Intenção:", analiseMensagem?.intencaoDetectada);
    console.log("Serviços carregados:", servicos?.map((s) => s.nome_servico));
    console.log(
      "Serviços detectados:",
      evidenciasBanco?.itens_detectados?.map((s) => s.nome_servico)
    );
    console.log("Evidências banco:", evidenciasBanco);

    let resposta = "";
    let origem_resposta = "gemini";

    try {
      const resultadoIA = await gerarRespostaComGemini(
        {
          ...contexto,
          evidencias_banco: evidenciasBanco
        },
        mensagem,
        analiseMensagem,
        perfilLead,
        estadoConversa
      );

      resposta = resultadoIA.resposta;

      if (!resposta || typeof resposta !== "string" || !resposta.trim()) {
        throw new Error("Resposta vazia do Gemini");
      }
    } catch (geminiError) {
      origem_resposta = "fallback";

      resposta = criarRespostaFallback({
        mensagem,
        empresa: {
          ...(contexto?.empresa || {}),
          evidencias_banco: evidenciasBanco
        },
        servicos,
        faq,
        analiseMensagem,
        perfilLead,
        estadoConversa
      });

      console.error("Erro Gemini /chat:", geminiError);
    }

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
      analiseMensagem,
      perfilLead,
      estadoConversa,
      evidenciasBanco
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
