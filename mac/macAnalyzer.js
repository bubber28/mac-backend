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
    textoMinusculo.includes("moçoa") ||
    textoMinusculo.includes("moça") ||
    textoMinusculo.includes("tipo") ||
    textoMinusculo.includes("cara");

  const caixaAlta = texto === texto.toUpperCase() && texto.length > 3;

  const temPontuacaoFormal =
    texto.includes("por favor") ||
    texto.includes("gostaria") ||
    texto.includes("poderia") ||
    texto.includes("bom dia") ||
    texto.includes("boa tarde") ||
    texto.includes("boa noite");

  let objetividade = "média";
  if (tamanhoMensagem <= 4) objetividade = "alta";
  if (tamanhoMensagem >= 12) objetividade = "baixa";

  let formalidade = "média";
  if (temPontuacaoFormal) formalidade = "alta";
  if (temGirias) formalidade = "baixa";

  let energia = "média";
  if (caixaAlta || texto.includes("!")) energia = "alta";
  if (texto.includes("...")) energia = "baixa";

  let perfilHipotese = "neutro";
  if (objetividade === "alta" && formalidade !== "alta") {
    perfilHipotese = "D";
  } else if (temGirias && energia === "alta") {
    perfilHipotese = "I";
  } else if (formalidade === "alta" && tamanhoMensagem > 8) {
    perfilHipotese = "C";
  } else if (energia === "baixa" && formalidade === "média") {
    perfilHipotese = "S";
  }

  let estrategia = "resposta_equilibrada";
  if (perfilHipotese === "D") estrategia = "resposta_curta_direta";
  if (perfilHipotese === "I") estrategia = "resposta_amigavel_dinamica";
  if (perfilHipotese === "C") estrategia = "resposta_clara_detalhada";
  if (perfilHipotese === "S") estrategia = "resposta_calma_acolhedora";

  return {
    textoOriginal: mensagem,
    tamanhoMensagem,
    objetividade,
    formalidade,
    energia,
    temGirias,
    caixaAlta,
    perfilHipotese,
    estrategia
  };
}

module.exports = { analyzeMessage };
