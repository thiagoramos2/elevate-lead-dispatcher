/**
 * Smooth weighted round robin (o algoritmo do nginx), materializado como um escalonamento fixo.
 *
 * Os pesos 5/3/2 geram o escalonamento de 10 posições A B C A A B A C B A: toda janela de
 * Σpesos escolhas consecutivas contém cada destino exatamente `weight` vezes, e as escolhas
 * do destino mais pesado ficam intercaladas em vez de virem em rajada.
 *
 * O escalonamento é uma função pura da configuração. A posição que cada lead ocupa é decidida
 * por um cursor global guardado no Postgres (ver ADR-0003), sem usar memória de processo.
 */

export interface WeightedTarget<Id> {
  readonly id: Id;
  readonly weight: number;
}

export class InvalidWeightsError extends Error {
  override readonly name = 'InvalidWeightsError';
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Monta o escalonamento. Empates são decididos pela ordem de entrada, então quem chama precisa
 * passar os destinos numa ordem estável (ex.: por slug) para o resultado ser reproduzível.
 */
export function buildWeightedSchedule<Id>(targets: readonly WeightedTarget<Id>[]): Id[] {
  if (targets.length === 0) {
    throw new InvalidWeightsError('at least one target is required');
  }
  for (const target of targets) {
    if (!Number.isSafeInteger(target.weight) || target.weight <= 0) {
      throw new InvalidWeightsError(`weight must be a positive integer, got ${target.weight}`);
    }
  }

  const divisor = targets.reduce((acc, t) => gcd(acc, t.weight), 0);
  const weights = targets.map((t) => t.weight / divisor);
  const total = weights.reduce((acc, w) => acc + w, 0);
  const current = weights.map(() => 0);
  const schedule: Id[] = [];

  for (let step = 0; step < total; step++) {
    let best = 0;
    for (let i = 0; i < weights.length; i++) {
      current[i] = (current[i] ?? 0) + (weights[i] ?? 0);
      if ((current[i] ?? 0) > (current[best] ?? 0)) best = i;
    }
    current[best] = (current[best] ?? 0) - total;
    // biome-ignore lint/style/noNonNullAssertion: `best` é sempre um índice válido de `targets`
    schedule.push(targets[best]!.id);
  }

  return schedule;
}

/**
 * Converte um cursor global (que começa em 1) numa posição do escalonamento. Os cursores n e
 * n + schedule.length sempre caem na mesma posição.
 */
export function pickSlot<Id>(schedule: readonly Id[], cursor: bigint): Id {
  if (schedule.length === 0) {
    throw new InvalidWeightsError('schedule is empty');
  }
  if (cursor < 1n) {
    throw new RangeError(`cursor must be >= 1, got ${cursor}`);
  }
  const index = Number((cursor - 1n) % BigInt(schedule.length));
  // biome-ignore lint/style/noNonNullAssertion: o índice está dentro dos limites por construção
  return schedule[index]!;
}
