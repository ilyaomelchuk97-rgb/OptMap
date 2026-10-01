// Общие функции оптимизатора.

/** Стоимость тура по порядку точек. roundTrip — замкнутый (возврат в начало). */
export function tourCost(m, order, roundTrip) {
  let s = 0;
  for (let i = 0; i + 1 < order.length; i++) s += m[order[i]][order[i + 1]];
  if (roundTrip && order.length > 2) s += m[order[order.length - 1]][order[0]];
  return s;
}
