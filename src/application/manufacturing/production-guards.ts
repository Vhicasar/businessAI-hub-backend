import { ValidationError } from '../../shared/errors';

export type ProductionGuardCode =
  | 'SOURCE_WAREHOUSE_REQUIRED'
  | 'DESTINATION_WAREHOUSE_REQUIRED'
  | 'MATERIALS_NOT_ISSUED'
  | 'MATERIALS_PARTIALLY_ISSUED'
  | 'NO_OUTPUT_RECORDED';

export interface GuardResult {
  allowed: boolean;
  code?: ProductionGuardCode;
  message?: string;
  maximumOutput?: number;
}

type GuardOrder = {
  warehouseId: string | null;
  finishedWarehouseId: string | null;
  plannedQuantity: unknown;
  actualQuantity?: unknown;
  materials: Array<{ requiredQuantity: unknown; issuedQuantity: unknown; receivedQuantity?: unknown }>;
};

export function canStartProduction(order: GuardOrder): GuardResult {
  if (!order.finishedWarehouseId) return blocked('DESTINATION_WAREHOUSE_REQUIRED', 'Select an active finished-goods warehouse before starting production.');
  if (order.materials.some((line) => Number(line.receivedQuantity ?? 0) <= 0)) {
    return blocked('MATERIALS_NOT_ISSUED', 'Required raw materials must be received by production before starting production.');
  }
  return { allowed: true };
}

/**
 * Partial issue is supported, but output is capped by the most constrained BOM
 * component. A half-issued recipe can produce at most half of its planned run.
 */
export function canRecordProduction(order: GuardOrder, additionalOutput: number): GuardResult {
  const start = canStartProduction(order);
  if (!start.allowed) return start;
  if (order.materials.length === 0) return { allowed: true, maximumOutput: Number(order.plannedQuantity) };
  const ratio = Math.min(...order.materials.map((line) => {
    const required = Number(line.requiredQuantity);
    return required <= 0 ? 1 : Math.min(1, Number(line.receivedQuantity ?? 0) / required);
  }));
  const maximumOutput = Number(order.plannedQuantity) * ratio;
  const totalAfter = Number(order.actualQuantity ?? 0) + additionalOutput;
  if (totalAfter > maximumOutput + 1e-6) {
    return {
      allowed: false,
      code: 'MATERIALS_PARTIALLY_ISSUED',
      message: `Issued materials currently support at most ${round3(maximumOutput)} units of output. Issue more materials before recording this quantity.`,
      maximumOutput: round3(maximumOutput),
    };
  }
  return { allowed: true, maximumOutput: round3(maximumOutput) };
}

export function canCompleteProduction(order: GuardOrder): GuardResult {
  if (Number(order.actualQuantity ?? 0) <= 0) return blocked('NO_OUTPUT_RECORDED', 'Record production output before completing this order.');
  if (order.materials.some((line) => Number(line.receivedQuantity ?? 0) + 1e-6 < Number(line.requiredQuantity))) {
    return blocked('MATERIALS_PARTIALLY_ISSUED', 'Receive all required materials before completing this production order.');
  }
  return { allowed: true };
}

export function enforceGuard(result: GuardResult): void {
  if (!result.allowed) throw new ValidationError(result.message ?? 'Production action is not allowed.');
}

const blocked = (code: ProductionGuardCode, message: string): GuardResult => ({ allowed: false, code, message });
const round3 = (value: number) => Math.round(value * 1000) / 1000;
