function analyzeMessage(mensagem = "") {
  const texto = mensagem.trim();
  const textoMinusculo = texto.toLowerCase();

  const palavras = texto.split(/\s+/).filter(Boolean);
  const tamanhoMensagem = palavras.length;

  const temGirias =
    textoMinusculo.includes("oii") ||
    textoMinusculo.includes("kkk") ||
    textoMinusculo.includes("mano") ||
    textoMinusculo.includes("moço") ||
    textoMinusculo.includes("moça") ||
    textoMinusculo.includes("tipo") ||
    textoMinusculo.includes("cara") ||
    textoMinusculo.includes("tô") ||
    textoMinusculo.includes("to ");

  const caixaAlta = texto === texto.toUpperCase() && texto.length > 3;

  const temPontuacaoFormal =
    textoMinusculo.includes("por favor") ||
    textoMinusculo.includes("gostaria") ||
    textoMinusculo.includes("poderia") ||
    textoMinusculo.includes("bom dia") ||
    textoMinusculo.includes("boa tarde") ||
    textoMinusculo.includes("boa noite");

  let objetividade = "média";
  if (tamanhoMensagem <= 4) objetividade = "alta";
  if (tamanhoMensagem >= 12) objetividade = "baixa";

  let formalidade = "média";
  if (temPontuacaoFormal) formalidade = "alta";
  if (temGirias) formalidade = "baixa";

  let energia = "média";
  if (caixaAlta || texto.includes("!")) energia = "alta";
  if (texto.includes("...")) energia = "baixa";

  let urgencia = "baixa";
  if (
    textoMinusculo.includes("urgente") ||
    textoMinusculo.includes("agora") ||
    textoMinusculo.includes("hoje") ||
    textoMinusculo.includes("rápido") ||
    textoMinusculo.includes("rapido")
  ) {
    urgencia = "alta";
  }

  let intencaoDetectada = "duvida_geral";

  if (
    textoMinusculo.includes("quanto custa") ||
    textoMinusculo.includes("valor") ||
    textoMinusculo.includes("preço") ||
    textoMinusculo.includes("preco")
  ) {
    intencaoDetectada = "orcamento";
  } else if (
    textoMinusculo.includes("horário") ||
    textoMinusculo.includes("horario") ||
    textoMinusculo.includes("atendem") ||
    textoMinusculo.includes("sábado") ||
    textoMinusculo.includes("sabado")
  ) {
    intencaoDetectada = "disponibilidade";
  } else if (
    textoMinusculo.includes("agendar") ||
    textoMinusculo.includes("marcar") ||
    textoMinusculo.includes("quero fazer") ||
    textoMinusculo.includes("posso marcar")
  ) {
    intencaoDetectada = "agendamento";
  } else if (
    textoMinusculo.includes("como funciona") ||
    textoMinusculo.includes("o que é") ||
    textoMinusculo.includes("explica") ||
    textoMinusculo.includes("me explica")
  ) {
    intencaoDetectada = "explicacao";
  }

  let scoreD = 0;
  let scoreI = 0;
  let scoreS = 0;
  let scoreC = 0;

  // Sinais de D
  if (objetividade === "alta") scoreD += 2;
  if (objetividade === "média") scoreD += 1;
  if (urgencia === "alta") scoreD += 1;
  if (intencaoDetectada === "orcamento") scoreD += 1;

  // Sinais de I
  if (temGirias) scoreI += 2;
  if (energia === "alta") scoreI += 2;
  if (texto.includes("😊") || texto.includes("😅") || texto.includes("😂")) scoreI += 1;

  // Sinais de S
  if (energia === "baixa") scoreS += 2;
  if (formalidade === "média") scoreS += 1;
  if (textoMinusculo.includes("quero entender")) scoreS += 1;
  if (intencaoDetectada === "disponibilidade") scoreS += 1;

  // Sinais de C
  if (formalidade === "alta") scoreC += 2;
  if (objetividade === "baixa") scoreC += 2;
  if (tamanhoMensagem > 10) scoreC += 1;
  if (
    textoMinusculo.includes("detalhe") ||
    textoMinusculo.includes("explica") ||
    textoMinusculo.includes("como funciona")
  ) {
    scoreC += 1;
  }

  let perfilHipotese = "N";

  const scores = [
    { perfil: "D", valor: scoreD },
    { perfil: "I", valor: scoreI },
    { perfil: "S", valor: scoreS },
    { perfil: "C", valor: scoreC }
  ].sort((a, b) => b.valor - a.valor);

  const maior = scores[0];
  const segundo = scores[1];

  if (maior.valor === 0) {
    perfilHipotese = "N";
  } else if (segundo.valor > 0 && maior.valor - segundo.valor <= 1) {
    const combinacao = `${maior.perfil}${segundo.perfil}`;

    if (
      combinacao === "DI" ||
      combinacao === "ID" ||
      combinacao === "DC" ||
      combinacao === "CD" ||
      combinacao === "IS" ||
      combinacao === "SI" ||
      combinacao === "SC" ||
      combinacao === "CS"
    ) {
      if (combinacao === "ID") perfilHipotese = "DI";
      else if (combinacao === "CD") perfilHipotese = "DC";
      else if (combinacao === "SI") perfilHipotese = "IS";
      else if (combinacao === "CS") perfilHipotese = "SC";
      else perfilHipotese = combinacao;
    } else {
      perfilHipotese = maior.perfil;
    }
  } else {
    perfilHipotese = maior.perfil;
  }

  let estrategia = "resposta_equilibrada";

  if (perfilHipotese === "D") estrategia = "resposta_curta_direta";
  if (perfilHipotese === "I") estrategia = "resposta_amigavel_dinamica";
  if (perfilHipotese === "S") estrategia = "resposta_calma_acolhedora";
  if (perfilHipotese === "C") estrategia = "resposta_clara_detalhada";
  if (perfilHipotese === "DI") estrategia = "resposta_direta_com_energia";
  if (perfilHipotese === "DC") estrategia = "resposta_curta_clara";
  if (perfilHipotese === "IS") estrategia = "resposta_amigavel_empatica";
  if (perfilHipotese === "SC") estrategia = "resposta_segura_organizada";
  if (perfilHipotese === "N") estrategia = "resposta_equilibrada";

  if (intencaoDetectada === "agendamento") {
    estrategia = "conducao_para_fechamento";
  }

  return {
    textoOriginal: mensagem,
    tamanhoMensagem,
    objetividade,
    formalidade,
    energia,
    urgencia,
    intencaoDetectada,
    temGirias,
    caixaAlta,
    scoreD,
    scoreI,
    scoreS,
    scoreC,
    perfilHipotese,
    estrategia
  };
}

module.exports = { analyzeMessage };
