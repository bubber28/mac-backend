const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { buildMacPrompt } = require("./mac/macPromptBuilder");
const { analyzeMessage } = require("./mac/macAnalyzer");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(geminiApiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

function criarRespostaFallback(contexto, mensagem) {
  const empresa = contexto?.empresa || {};
  const servicos = contexto?.servicos || [];
  const faq = contexto?.faq || [];

  const msg = mensagem.toLowerCase();

  const servicoEncontrado = servicos.find((s) =>
    msg.includes((s.nome_servico || "").toLowerCase())
  );

  if (servicoEncontrado) {
    const preco =
      servicoEncontrado.preco !== null && servicoEncontrado.preco !== undefined
        ? `R$${servicoEncontrado.preco}`
        : "valor sob consulta";

    const tempo = servicoEncontrado.tempo_atendimento
      ? ` e leva cerca de ${servicoEncontrado.tempo_atendimento}`
      : "";

    return `Claro! O serviço ${servicoEncontrado.nome_servico} custa ${preco}${tempo}.`;
  }

  const faqEncontrada = faq.find((f) =>
    msg.includes((f.pergunta || "").toLowerCase().split("?")[0])
  );

  if (faqEncontrada) {
    return faqEncontrada.resposta;
  }

  if (msg.includes("sábado") || msg.includes("sabado")) {
    const faqSabado = faq.find((f) =>
      (f.pergunta || "").toLowerCase().includes("sábado") ||
      (f.pergunta || "").toLowerCase().includes("sabado")
    );

    if (faqSabado) {
      return faqSabado.resposta;
    }
  }

  const nomeEmpresa = empresa.nome_empresa || "a empresa";

  return `Recebi sua mensagem e registrei seu atendimento com ${nomeEmpresa}. No momento estou com instabilidade temporária na IA, mas posso continuar com informações básicas da empresa ou encaminhar sua dúvida para confirmação da equipe.`;
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
    estrategia: analiseMensagem.estrategia || null
  };

  const { error } = await supabase
    .from("analise_conversa_mac")
    .insert(payload);

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

  if (maior.valor === 0) {
    return "N";
  }

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

  const { count, error: countError } = await supabase
    .from("analise_conversa_mac")
    .select("*", { count: "exact", head: true })
    .eq("lead_id", leadId);

  if (countError) {
    throw new Error(`Erro ao contar análises do lead: ${countError.message}`);
  }

  const mensagensAnalisadas = count || 0;

  const { data: perfilExistente, error: perfilError } = await supabase
    .from("perfil_lead_mac")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle();

  if (perfilError) {
    throw new Error(`Erro ao buscar perfil do lead: ${perfilError.message}`);
  }

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

  const estrategiaDominante = calcularEstrategiaPorPerfil(perfilEstimado);

  const payload = {
    lead_id: leadId,
    perfil_estimado: perfilEstimado,
    confianca,
    mensagens_analisadas: mensagensAnalisadas,
    estrategia_dominante: estrategiaDominante,
    ultimo_perfil_detectado: analiseMensagem.perfilHipotese || "N",
    updated_at: new Date().toISOString(),
    score_d: novoScoreD,
    score_i: novoScoreI,
    score_s: novoScoreS,
    score_c: novoScoreC
  };

  if (perfilExistente?.id) {
    const { error: updateError } = await supabase
      .from("perfil_lead_mac")
      .update(payload)
      .eq("id", perfilExistente.id);

    if (updateError) {
      throw new Error(`Erro ao atualizar perfil do lead: ${updateError.message}`);
    }
  } else {
    const { error: insertError } = await supabase
      .from("perfil_lead_mac")
      .insert(payload);

    if (insertError) {
      throw new Error(`Erro ao criar perfil do lead: ${insertError.message}`);
    }
  }
}

async function gerarRespostaComGemini(contexto, mensagem) {
  const analiseMensagem = analyzeMessage(mensagem);

  const prompt = buildMacPrompt({
    contextoEmpresa: contexto,
    mensagemCliente: mensagem,
    analiseMensagem
  });

  const result = await model.generateContent(prompt);

  return {
    resposta: result.response.text().trim(),
    analiseMensagem
  };
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
    let resposta = "";
    let origem_resposta = "gemini";
    let analiseMensagem = analyzeMessage(mensagem);

    try {
      const resultadoIA = await gerarRespostaComGemini(contexto, mensagem);
      resposta = resultadoIA.resposta;
      analiseMensagem = resultadoIA.analiseMensagem;
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback(contexto, mensagem);
      console.error("Erro Gemini /teste:", geminiError.message);
    }

    await salvarAnaliseConversa(entradaData.lead_id, analiseMensagem);
    await atualizarPerfilLead(entradaData.lead_id, analiseMensagem);

    const { error: respostaError } = await supabase.rpc(
      "registrar_resposta_mac",
      {
        p_lead_id: entradaData.lead_id,
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
      lead_id: entradaData.lead_id,
      pergunta: mensagem,
      resposta,
      origem_resposta,
      analiseMensagem
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

    if (!empresa_id || !telefone || !mensagem) {
      return res.status(400).json({
        error: "empresa_id, telefone e mensagem são obrigatórios"
      });
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

    let resposta = "";
    let origem_resposta = "gemini";
    let analiseMensagem = analyzeMessage(mensagem);

    try {
      const resultadoIA = await gerarRespostaComGemini(contexto, mensagem);
      resposta = resultadoIA.resposta;
      analiseMensagem = resultadoIA.analiseMensagem;
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback(contexto, mensagem);
      console.error("Erro Gemini /chat:", geminiError.message);
    }

    await salvarAnaliseConversa(leadId, analiseMensagem);
    await atualizarPerfilLead(leadId, analiseMensagem);

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
      resposta,
      origem_resposta,
      analiseMensagem
    });
  } catch (err) {
    return res.status(500).json({
      error: "Erro interno no /chat",
      details: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor M.A.C. rodando na porta ${PORT}`);
});
