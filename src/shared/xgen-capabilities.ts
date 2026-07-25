export const PATHFINDER_XGEN_CONTRACT_VERSION = 1;

export const PATHFINDER_CORE_CAPABILITIES = [
  'trace_collection_import',
  'collection_build_status',
] as const;

export const PATHFINDER_DESIRED_CAPABILITIES = [
  ...PATHFINDER_CORE_CAPABILITIES,
  'collection_quality_summaries',
  'collection_search',
  'collection_plan',
  'collection_execute',
  'quality_lab',
  'auth_profile_resolution',
] as const;

export type XgenCompatibilityStatus =
  | 'compatible'
  | 'compatible_with_warnings'
  | 'legacy_unverified'
  | 'authentication_required'
  | 'backend_outdated'
  | 'extension_outdated'
  | 'invalid_manifest'
  | 'unavailable';

export interface XgenCapabilityManifest {
  contract: {
    name: string;
    version: number;
    min_client_version: number;
    max_client_version: number;
  };
  engine?: {
    graph_tool_call_version?: string | null;
  };
  capabilities: Record<string, boolean>;
  endpoints?: Record<string, {
    method?: string;
    path?: string;
  }>;
}

export interface XgenCompatibilityIssue {
  code:
    | 'manifest_not_supported'
    | 'authentication_required'
    | 'manifest_invalid'
    | 'backend_unreachable'
    | 'backend_contract_too_old'
    | 'extension_contract_too_old'
    | 'required_capability_missing'
    | 'desired_capability_missing';
  severity: 'warning' | 'error';
  message: string;
  capability?: string;
}

export interface XgenCompatibilityResult {
  status: XgenCompatibilityStatus;
  compatible: boolean;
  source: 'manifest' | 'legacy_probe' | 'request_failure';
  clientContractVersion: number;
  backendContractVersion?: number;
  graphToolCallVersion?: string | null;
  capabilities: Record<string, boolean>;
  missingRequiredCapabilities: string[];
  missingDesiredCapabilities: string[];
  issues: XgenCompatibilityIssue[];
}

interface DiagnoseOptions {
  requiredCapabilities?: readonly string[];
  desiredCapabilities?: readonly string[];
  fetchImpl?: typeof fetch;
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isManifest(value: unknown): value is XgenCapabilityManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<XgenCapabilityManifest>;
  const contract = manifest.contract as
    | Partial<XgenCapabilityManifest['contract']>
    | undefined;
  return (
    contract?.name === 'xgen-pathfinder-api-collection'
    && Number.isInteger(contract.version)
    && Number.isInteger(contract.min_client_version)
    && Number.isInteger(contract.max_client_version)
    && Boolean(manifest.capabilities)
    && typeof manifest.capabilities === 'object'
    && Object.values(manifest.capabilities).every((supported) =>
      typeof supported === 'boolean')
  );
}

async function legacyProbe(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<XgenCompatibilityResult> {
  const probes = [
    ['collection_catalog', '/api/tools/api-collections'],
    ['llm_provider_catalog', '/api/ai-chat/providers'],
    ['auth_profile_resolution', '/api/session-station/v1/auth-profiles'],
    ['mcp_session_catalog', '/api/mcp/sessions'],
  ] as const;
  const results = await Promise.all(probes.map(async ([capability, path]) => {
    try {
      const response = await fetchImpl(`${serverUrl}${path}`, {
        headers: authHeaders(token),
      });
      return {
        capability,
        supported: response.ok,
        authRequired: response.status === 401 || response.status === 403,
      };
    } catch {
      return { capability, supported: false, authRequired: false };
    }
  }));
  const capabilities = Object.fromEntries(
    results.map(({ capability, supported }) => [capability, supported]),
  );
  const anyReachable = results.some(({ supported, authRequired }) =>
    supported || authRequired);
  const authenticationRequired = results.some(({ authRequired }) => authRequired);

  if (!anyReachable) {
    return {
      status: 'unavailable',
      compatible: false,
      source: 'request_failure',
      clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
      capabilities,
      missingRequiredCapabilities: [...PATHFINDER_CORE_CAPABILITIES],
      missingDesiredCapabilities: [...PATHFINDER_DESIRED_CAPABILITIES],
      issues: [{
        code: 'backend_unreachable',
        severity: 'error',
        message: 'XGEN backend에 연결할 수 없습니다.',
      }],
    };
  }

  return {
    status: authenticationRequired ? 'authentication_required' : 'legacy_unverified',
    compatible: !authenticationRequired,
    source: 'legacy_probe',
    clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
    capabilities,
    missingRequiredCapabilities: [],
    missingDesiredCapabilities: [],
    issues: [{
      code: authenticationRequired
        ? 'authentication_required'
        : 'manifest_not_supported',
      severity: authenticationRequired ? 'error' : 'warning',
      message: authenticationRequired
        ? 'XGEN 로그인 컨텍스트가 필요합니다.'
        : '구버전 XGEN이라 기능별 실행 결과로 호환성을 확인합니다.',
    }],
  };
}

export async function diagnoseXgenCompatibility(
  serverUrl: string,
  token: string,
  options: DiagnoseOptions = {},
): Promise<XgenCompatibilityResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const required = options.requiredCapabilities ?? PATHFINDER_CORE_CAPABILITIES;
  const desired = options.desiredCapabilities ?? PATHFINDER_DESIRED_CAPABILITIES;
  let response: Response;
  try {
    response = await fetchImpl(
      `${serverUrl}/api/tools/api-collections/capabilities`,
      { headers: authHeaders(token) },
    );
  } catch {
    return legacyProbe(serverUrl, token, fetchImpl);
  }

  if (response.status === 404 || response.status === 405) {
    return legacyProbe(serverUrl, token, fetchImpl);
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: 'authentication_required',
      compatible: false,
      source: 'request_failure',
      clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
      capabilities: {},
      missingRequiredCapabilities: [...required],
      missingDesiredCapabilities: [...desired],
      issues: [{
        code: 'authentication_required',
        severity: 'error',
        message: 'XGEN 로그인 컨텍스트가 필요합니다.',
      }],
    };
  }
  if (!response.ok) {
    return {
      status: 'unavailable',
      compatible: false,
      source: 'request_failure',
      clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
      capabilities: {},
      missingRequiredCapabilities: [...required],
      missingDesiredCapabilities: [...desired],
      issues: [{
        code: 'backend_unreachable',
        severity: 'error',
        message: `XGEN capability 조회 실패 (${response.status})`,
      }],
    };
  }

  const payload = await response.json().catch(() => null);
  if (!isManifest(payload)) {
    return {
      status: 'invalid_manifest',
      compatible: false,
      source: 'manifest',
      clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
      capabilities: {},
      missingRequiredCapabilities: [...required],
      missingDesiredCapabilities: [...desired],
      issues: [{
        code: 'manifest_invalid',
        severity: 'error',
        message: 'XGEN capability 응답 형식이 Pathfinder 계약과 다릅니다.',
      }],
    };
  }

  const missingRequiredCapabilities = required.filter(
    (capability) => payload.capabilities[capability] !== true,
  );
  const missingDesiredCapabilities = desired.filter(
    (capability) =>
      !required.includes(capability)
      && payload.capabilities[capability] !== true,
  );
  const issues: XgenCompatibilityIssue[] = [];
  let status: XgenCompatibilityStatus = 'compatible';

  if (PATHFINDER_XGEN_CONTRACT_VERSION < payload.contract.min_client_version) {
    status = 'extension_outdated';
    issues.push({
      code: 'extension_contract_too_old',
      severity: 'error',
      message: 'Pathfinder 확장 업데이트가 필요합니다.',
    });
  } else if (
    PATHFINDER_XGEN_CONTRACT_VERSION > payload.contract.max_client_version
  ) {
    status = 'backend_outdated';
    issues.push({
      code: 'backend_contract_too_old',
      severity: 'error',
      message: 'XGEN backend 업데이트가 필요합니다.',
    });
  }

  for (const capability of missingRequiredCapabilities) {
    status = 'backend_outdated';
    issues.push({
      code: 'required_capability_missing',
      severity: 'error',
      capability,
      message: `필수 XGEN 기능을 지원하지 않습니다: ${capability}`,
    });
  }
  for (const capability of missingDesiredCapabilities) {
    if (status === 'compatible') status = 'compatible_with_warnings';
    issues.push({
      code: 'desired_capability_missing',
      severity: 'warning',
      capability,
      message: `일부 XGEN 기능을 지원하지 않습니다: ${capability}`,
    });
  }

  return {
    status,
    compatible: status === 'compatible' || status === 'compatible_with_warnings',
    source: 'manifest',
    clientContractVersion: PATHFINDER_XGEN_CONTRACT_VERSION,
    backendContractVersion: payload.contract.version,
    graphToolCallVersion: payload.engine?.graph_tool_call_version,
    capabilities: { ...payload.capabilities },
    missingRequiredCapabilities,
    missingDesiredCapabilities,
    issues,
  };
}

export function xgenCompatibilityLabel(result: XgenCompatibilityResult): string {
  switch (result.status) {
    case 'compatible':
      return `연동 계약 v${result.backendContractVersion} · 호환`;
    case 'compatible_with_warnings':
      return '연동 가능 · 일부 기능 미지원';
    case 'legacy_unverified':
      return '구버전 XGEN · 기능별 확인';
    case 'authentication_required':
      return 'XGEN 로그인 필요';
    case 'backend_outdated':
      return 'XGEN backend 업데이트 필요';
    case 'extension_outdated':
      return 'Pathfinder 업데이트 필요';
    case 'invalid_manifest':
      return '호환성 응답 오류';
    case 'unavailable':
      return 'XGEN 연결 실패';
  }
}

export class XgenCompatibilityError extends Error {
  readonly result: XgenCompatibilityResult;

  constructor(result: XgenCompatibilityResult) {
    super(xgenCompatibilityLabel(result));
    this.name = 'XgenCompatibilityError';
    this.result = result;
  }
}

export function assertXgenCompatibility(result: XgenCompatibilityResult): void {
  if (
    result.compatible
    || result.status === 'legacy_unverified'
  ) {
    return;
  }
  throw new XgenCompatibilityError(result);
}

export function capabilityApiErrorMessage(
  capability: string,
  status: number,
  fallback: string,
): string {
  const labels: Record<string, string> = {
    trace_collection_import: 'Trace Collection 등록',
    collection_build_status: 'Collection build 상태 조회',
    source_preview: 'Collection source 미리보기',
    universal_source_ingest: 'Collection source 등록',
    mcp_source_ingest: 'MCP source 등록',
  };
  const label = labels[capability] ?? capability;
  if (status === 404 || status === 405) {
    return `${fallback}: 현재 XGEN backend가 ${label} 기능을 지원하지 않습니다.`;
  }
  if (status === 401 || status === 403) {
    return `${fallback}: XGEN 로그인 컨텍스트가 필요합니다.`;
  }
  return `${fallback}: ${status}`;
}
