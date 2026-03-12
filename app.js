const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");
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
const ai = new GoogleGenAI({
  apiKey: geminiApiKey
});
function criarRespostaFallback(contexto, mensagem, perfilLead = null, estadoConversa = null) {
  const empresa = contexto?.empresa || {};
  const servicos = contexto?.servicos || [];
  const faq = contexto?.faq || [];

  const msg = mensagem.toLowerCase();
  const perfil = perfilLead?.perfil_estimado || "N";
  const etapa = estadoConversa?.etapa_conversa || "aberta";

  function modularTexto(base, detalhada, acolhedora, dinamica) {
    if (perfil === "D" || perfil === "DC" || perfil === "DI") return base;
    if (perfil === "C" || perfil === "SC") return detalhada;
    if (perfil === "S" || perfil === "IS") return acolhedora;
    if (perfil === "I") return dinamica;
    return base;
  }

  function adicionarConducao(textoBase) {
    if (etapa === "interesse") {
      if (perfil === "D" || perfil === "DC" || perfil === "DI") {
        return `${textoBase} Quer que eu veja um horário disponível?`;
      }
      if (perfil === "C" || perfil === "SC") {
        return `${textoBase} Se quiser, também posso te explicar os próximos passos de atendimento.`;
      }
      if (perfil === "S" || perfil === "IS") {
        return `${textoBase} Se quiser, posso seguir te ajudando com calma no próximo passo 😊`;
      }
      if (perfil === "I") {
        return `${textoBase} Se quiser, já posso te passar o próximo passo 😊`;
      }
    }

    if (etapa === "consideracao") {
      if (perfil === "D" || perfil === "DC" || perfil === "DI") {
        return `${textoBase} Posso te passar o próximo passo objetivamente.`;
      }
      if (perfil === "C" || perfil === "SC") {
        return `${textoBase} Se quiser, posso organizar melhor as informações para você.`;
      }
      if (perfil === "S" || perfil === "IS") {
        return `${textoBase} Se quiser, sigo te explicando com calma 😊`;
      }
      if (perfil === "I") {
        return `${textoBase} Se quiser, já continuo com mais detalhes 😊`;
      }
    }

    if (etapa === "fechamento") {
      if (perfil === "D" || perfil === "DC" || perfil === "DI") {
        return `${textoBase} Posso seguir com o agendamento.`;
      }
      return `${textoBase} Se quiser, posso continuar com o agendamento.`;
    }

    return textoBase;
  }

  const servicoEncontrado = servicos.find((s) =>
    msg.includes((s.nome_servico || "").toLowerCase())
  );

  if (servicoEncontrado) {
    const preco =
      servicoEncontrado.preco !== null && servicoEncontrado.preco !== undefined
        ? `R$${servicoEncontrado.preco}`
        : "valor sob consulta";

    const tempo = servicoEncontrado.tempo_atendimento
      ? `${servicoEncontrado.tempo_atendimento}`
      : "tempo sob consulta";

    const texto = modularTexto(
      `${servicoEncontrado.nome_servico}: ${preco}. Duração média de ${tempo}.`,
      `O serviço ${servicoEncontrado.nome_servico} custa ${preco} e tem duração média de ${tempo}. Se quiser, também posso te explicar melhor como funciona.`,
      `Claro, posso te ajudar 😊 O serviço ${servicoEncontrado.nome_servico} custa ${preco} e dura cerca de ${tempo}.`,
      `Fazemos sim 😊 O serviço ${servicoEncontrado.nome_servico} custa ${preco} e leva cerca de ${tempo}.`
    );

    return adicionarConducao(texto);
  }

  const faqEncontrada = faq.find((f) =>
    msg.includes((f.pergunta || "").toLowerCase().split("?")[0])
  );

  if (faqEncontrada) {
    const texto = modularTexto(
      faqEncontrada.resposta,
      `${faqEncontrada.resposta} Se quiser, posso detalhar melhor.`,
      `${faqEncontrada.resposta} Qualquer coisa, sigo te ajudando com calma 😊`,
      `${faqEncontrada.resposta} Se quiser, já posso te passar mais informações 😊`
    );

    return adicionarConducao(texto);
  }

  if (msg.includes("sábado") || msg.includes("sabado")) {
    const faqSabado = faq.find((f) =>
      (f.pergunta || "").toLowerCase().includes("sábado") ||
      (f.pergunta || "").toLowerCase().includes("sabado")
    );

    if (faqSabado) {
      const texto = modularTexto(
        faqSabado.resposta,
        `${faqSabado.resposta} Se quiser, posso detalhar horários e funcionamento.`,
        `${faqSabado.resposta} Se quiser, te explico direitinho 😊`,
        `${faqSabado.resposta} Se quiser, já te passo mais detalhes 😊`
      );

      return adicionarConducao(texto);
    }
  }

  const nomeEmpresa = empresa.nome_empresa || "a empresa";

  const textoBase = modularTexto(
    `Recebi sua mensagem e registrei seu atendimento com ${nomeEmpresa}. Posso seguir com informações básicas ou encaminhar sua dúvida para confirmação da equipe.`,
    `Recebi sua mensagem e registrei seu atendimento com ${nomeEmpresa}. Posso continuar com informações básicas da empresa ou detalhar sua dúvida para confirmação da equipe.`,
    `Recebi sua mensagem e já registrei seu atendimento com ${nomeEmpresa}. Vou seguir te ajudando com as informações disponíveis 😊`,
    `Recebi sua mensagem e registrei seu atendimento com ${nomeEmpresa}. Posso continuar te ajudando por aqui 😊`
  );

  return adicionarConducao(textoBase);
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
      contents: prompt
    });

    const texto = response?.text?.trim() || "";

    return {
      resposta: texto || "Desculpe, não consegui gerar uma resposta agora."
    };
  } catch (error) {
    console.error("Erro Gemini:", error.message);
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
    let resposta = "";
    let origem_resposta = "gemini";
    const analiseMensagem = analyzeMessage(mensagem);

    await salvarAnaliseConversa(entradaData.lead_id, analiseMensagem);
    await atualizarPerfilLead(entradaData.lead_id, analiseMensagem);
    await atualizarEstadoConversaLead(entradaData.lead_id, analiseMensagem);

    const perfilLead = await buscarPerfilLead(entradaData.lead_id);
    const estadoConversa = await buscarEstadoConversaLead(entradaData.lead_id);

    try {
      const resultadoIA = await gerarRespostaComGemini(
        contexto,
        mensagem,
        analiseMensagem,
        perfilLead,
        estadoConversa
      );
      resposta = resultadoIA.resposta;
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback(contexto, mensagem, perfilLead, estadoConversa);
      console.error("Erro Gemini /teste:", geminiError.message);
    }

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
    const analiseMensagem = analyzeMessage(mensagem);

    await salvarAnaliseConversa(leadId, analiseMensagem);
    await atualizarPerfilLead(leadId, analiseMensagem);
    await atualizarEstadoConversaLead(leadId, analiseMensagem);

    const perfilLead = await buscarPerfilLead(leadId);
    const estadoConversa = await buscarEstadoConversaLead(leadId);

    try {
      const resultadoIA = await gerarRespostaComGemini(
        contexto,
        mensagem,
        analiseMensagem,
        perfilLead,
        estadoConversa
      );
      resposta = resultadoIA.resposta;
    } catch (geminiError) {
      origem_resposta = "fallback";
      resposta = criarRespostaFallback(contexto, mensagem, perfilLead, estadoConversa);
      console.error("Erro Gemini /chat:", geminiError.message);
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
      resposta,
      origem_resposta,
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
  console.log(`Servidor M.A.C. rodando na porta ${PORT}`);
});
