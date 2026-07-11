export function calculateFormula(source) {
  const cleaned = String(source || "").replace(/[+\-*/.]$/, "");
  if (!cleaned || !/^[0-9+\-*/. ]+$/.test(cleaned)) return null;
  try {
    const result = Math.round(Function(`"use strict"; return (${cleaned})`)() * 100) / 100;
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

export function nextFormulaForKey(formula, calculatedAmount, value) {
  const operators = ["+", "-", "*", "/"];
  if (operators.includes(value)) {
    if (!formula && !calculatedAmount) return formula;
    return operators.includes(formula.slice(-1)) ? `${formula.slice(0, -1)}${value}` : `${formula || calculatedAmount}${value}`;
  }
  if (value === ".") {
    const current = formula.split(/[+\-*/]/).pop() || "";
    if (current.includes(".")) return formula;
    return formula + (current ? "." : "0.");
  }
  return formula + value;
}
