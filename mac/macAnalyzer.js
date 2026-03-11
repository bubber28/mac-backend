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

  let perfilHipotese = "neutro";

  if (objetividade === "alta" && formalidade !== "alta") {
    perfilHipotese = "D";
  } else if (temGirias && energia === "alta") {
    perfilHipotese = "I";
  } else if (formalidade === "alta" && tamanhoMensagem > 8) {
    perfilHipotese = "C";
  } else if (energia === "baixa" && formalidade === "média") {
    perfilHipotese = "S";
  } else if (formalidade === "alta" && objetividade === "baixa") {
    perfilHipotese = "C/S";
  }

  let estrategia = "resposta_equilibrada";

  if (perfilHipotese === "D") estrategia = "resposta_curta_direta";
  if (perfilHipotese === "I") estrategia = "resposta_amigavel_dinamica";
  if (perfilHipotese === "C") estrategia = "resposta_clara_detalhada";
  if (perfilHipotese === "S") estrategia = "resposta_calma_acolhedora";
  if (perfilHipotese === "C/S") estrategia = "resposta_segura_organizada";

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
    perfilHipotese,
    estrategia
  };
}

module.exports = { analyzeMessage };
