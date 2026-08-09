export interface PlanStepArguments {
  tool: string;
  args?: Record<string, unknown>;
}

export interface MissingPlanArgument {
  tool: string;
  field: string;
}

export function isStepBinding(value: string): boolean {
  return /^\$\{[^{}]+\}$/.test(value.trim());
}

function findMissingLiteralArgument(
  args: Record<string, unknown> | undefined,
  prefix = '',
): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const [key, value] of Object.entries(args)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) return path;
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized === '') return path;
      if (isStepBinding(normalized)) continue;
      // This brace-only form is not a step binding in the current Collection plan
      // contract and represents an unresolved literal placeholder.
      if (/^\{[A-Za-z_][\w-]*\}$/.test(normalized)) return path;
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = findMissingLiteralArgument(value as Record<string, unknown>, path);
      if (nested) return nested;
    }
  }
  return null;
}

export function findFirstMissingPlanArgument(
  plan: { steps?: PlanStepArguments[] },
): MissingPlanArgument | null {
  for (const step of plan.steps || []) {
    const field = findMissingLiteralArgument(step.args);
    if (field) return { tool: step.tool, field };
  }
  return null;
}

/**
 * HTTP 실행이 이미 실패한 뒤 사용자 입력으로 복구할 후보를 찾는다.
 * 이 단계에서는 정상적으로 보였던 step binding도 backend에서 해석되지 않은 채
 * 남았을 수 있으므로 suspicious 값으로 취급한다.
 */
export function findSuspiciousRuntimeArgument(
  args: Record<string, unknown> | undefined,
  prefix = '',
): string | null {
  if (!args || typeof args !== 'object') return null;
  for (const [key, value] of Object.entries(args)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) return path;
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized === '') return path;
      if (isStepBinding(normalized)) return path;
      if (/^\{[A-Za-z_][\w-]*\}$/.test(normalized)) return path;
      continue;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = findSuspiciousRuntimeArgument(value as Record<string, unknown>, path);
      if (nested) return nested;
    }
  }
  return null;
}
