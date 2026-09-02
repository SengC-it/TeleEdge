function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sigmoid(value) {
  const clipped = Math.max(-40, Math.min(40, Number(value) || 0));
  return 1 / (1 + Math.exp(-clipped));
}

function solve(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) a[pivot][column] += 1e-9;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column] || 1e-9;
    for (let j = column; j <= n; j++) a[column][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = a[row][column];
      if (!factor) continue;
      for (let j = column; j <= n; j++) a[row][j] -= factor * a[column][j];
    }
  }
  return a.map(row => finite(row[n]));
}

function validateDesign(X, y) {
  const rows = Array.isArray(X) ? X : [];
  const targets = Array.isArray(y) ? y : [];
  const usable = [];
  for (let index = 0; index < Math.min(rows.length, targets.length); index++) {
    const row = Array.isArray(rows[index]) ? rows[index].map(value => finite(value)) : [];
    if (!row.length || !Number.isFinite(Number(targets[index]))) continue;
    usable.push({row, target: Number(targets[index])});
  }
  return usable;
}

export function fitRidge(X, y, {lambda = 1, featureNames = []} = {}) {
  const usable = validateDesign(X, y);
  const dimension = usable[0]?.row.length || featureNames.length || 0;
  const size = dimension + 1;
  const gram = Array.from({length: size}, () => Array(size).fill(0));
  const cross = Array(size).fill(0);
  for (const {row, target} of usable) {
    const values = [1, ...row];
    for (let i = 0; i < size; i++) {
      cross[i] += values[i] * target;
      for (let j = 0; j < size; j++) gram[i][j] += values[i] * values[j];
    }
  }
  const regularization = Math.max(0, Number(lambda) || 0);
  for (let i = 1; i < size; i++) gram[i][i] += regularization;
  const solution = size ? solve(gram, cross) : [];
  return {
    type: 'ridge', lambda: regularization, featureNames: [...featureNames],
    intercept: solution[0] || 0, coefficients: solution.slice(1),
    sample: usable.length,
  };
}

export function predictLinear(model, row) {
  const values = Array.isArray(row) ? row : [];
  return finite(model?.intercept) + (model?.coefficients || []).reduce((sum, coefficient, index) => sum + finite(coefficient) * finite(values[index]), 0);
}

export function fitLogistic(X, y, {lambda = 0.1, featureNames = [], maxIterations = 250, learningRate = 0.08} = {}) {
  const usable = validateDesign(X, y);
  const dimension = usable[0]?.row.length || featureNames.length || 0;
  let coefficients = Array(dimension).fill(0);
  const positiveRate = usable.length ? usable.reduce((sum, row) => sum + (row.target > 0 ? 1 : 0), 0) / usable.length : 0.5;
  let intercept = Math.log(Math.max(1e-6, positiveRate) / Math.max(1e-6, 1 - positiveRate));
  let converged = false;
  let iterations = 0;
  for (iterations = 0; iterations < maxIterations; iterations++) {
    const gradient = Array(dimension).fill(0);
    let interceptGradient = 0;
    for (const {row, target} of usable) {
      const probability = sigmoid(intercept + row.reduce((sum, value, index) => sum + coefficients[index] * value, 0));
      const error = probability - (target > 0 ? 1 : 0);
      interceptGradient += error;
      for (let index = 0; index < dimension; index++) gradient[index] += error * row[index];
    }
    const scale = 1 / Math.max(1, usable.length);
    const previous = intercept;
    intercept -= learningRate * interceptGradient * scale;
    let movement = Math.abs(intercept - previous);
    for (let index = 0; index < dimension; index++) {
      const next = coefficients[index] - learningRate * (gradient[index] * scale + Number(lambda || 0) * coefficients[index]);
      movement = Math.max(movement, Math.abs(next - coefficients[index]));
      coefficients[index] = next;
    }
    if (movement < 1e-7) { converged = true; break; }
  }
  return {type: 'logistic', lambda: Number(lambda) || 0, featureNames: [...featureNames], intercept, coefficients, sample: usable.length, iterations: iterations + 1, converged};
}

export function predictProbability(model, row) {
  return sigmoid(predictLinear(model, row));
}

export function coefficientSummary(model) {
  return (model?.featureNames || []).map((name, index) => ({feature: name, coefficient: finite(model?.coefficients?.[index])}));
}
