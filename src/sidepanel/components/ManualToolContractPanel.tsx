import { useMemo, useState } from 'react';
import {
  buildManualToolContractSource,
  type ManualAuthType,
  type ManualHttpMethod,
  type ManualParameterLocation,
  type ManualSchemaType,
  type ManualToolParameter,
  type ManualToolContractSource,
} from '../lib/manual-tool-contract';
import { OpenApiImportPanel } from './OpenApiImportPanel';

interface Props {
  targetTabId?: number | null;
  targetTabUrl?: string | null;
  onDismiss: () => void;
}

interface ParameterRow extends ManualToolParameter {
  id: number;
}

const METHODS: ManualHttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];
const LOCATIONS: ManualParameterLocation[] = ['query', 'path', 'header', 'cookie'];
const SCHEMA_TYPES: ManualSchemaType[] = ['string', 'integer', 'number', 'boolean', 'array'];
const AUTH_TYPES: Array<{ value: ManualAuthType; label: string }> = [
  { value: 'none', label: '인증 없음' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'basic', label: 'HTTP Basic' },
  { value: 'apiKeyHeader', label: 'API key header' },
  { value: 'apiKeyQuery', label: 'API key query' },
  { value: 'cookie', label: 'Cookie' },
];

const fieldClass = 'border border-gray-200 bg-white px-2 py-1.5 text-[10px] outline-none focus:border-blue-400';

function suggestedEndpoint(tabUrl: string | null | undefined): string {
  if (!tabUrl) return '';
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}/api/`;
  } catch {
    return '';
  }
}

function authNamePlaceholder(authType: ManualAuthType): string {
  if (authType === 'apiKeyHeader') return 'X-API-Key';
  if (authType === 'apiKeyQuery') return 'api_key';
  if (authType === 'cookie') return 'session';
  return '';
}

export function ManualToolContractPanel({
  targetTabId,
  targetTabUrl,
  onDismiss,
}: Props) {
  const initialEndpoint = useMemo(() => suggestedEndpoint(targetTabUrl), [targetTabUrl]);
  const [endpointUrl, setEndpointUrl] = useState(initialEndpoint);
  const [method, setMethod] = useState<ManualHttpMethod>('GET');
  const [operationId, setOperationId] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [parameters, setParameters] = useState<ParameterRow[]>([]);
  const [requestSchemaText, setRequestSchemaText] = useState('');
  const [responseSchemaText, setResponseSchemaText] = useState('');
  const [requestContentType, setRequestContentType] = useState('application/json');
  const [responseContentType, setResponseContentType] = useState('application/json');
  const [responseStatus, setResponseStatus] = useState('200');
  const [authType, setAuthType] = useState<ManualAuthType>('none');
  const [authName, setAuthName] = useState('');
  const [nextParameterId, setNextParameterId] = useState(1);
  const [prepared, setPrepared] = useState<ManualToolContractSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateParameter = (
    id: number,
    patch: Partial<Omit<ParameterRow, 'id'>>,
  ) => {
    setParameters((rows) => rows.map((row) => (
      row.id === id ? { ...row, ...patch } : row
    )));
  };

  const addParameter = () => {
    setParameters((rows) => [
      ...rows,
      {
        id: nextParameterId,
        name: '',
        location: 'query',
        schemaType: 'string',
        required: false,
      },
    ]);
    setNextParameterId((id) => id + 1);
  };

  const buildSource = () => {
    setError(null);
    try {
      setPrepared(buildManualToolContractSource({
        endpointUrl,
        method,
        operationId,
        summary,
        description,
        parameters: parameters.map(({ id: _id, ...parameter }) => parameter),
        requestSchemaText,
        responseSchemaText,
        requestContentType,
        responseContentType,
        responseStatus,
        authType,
        authName,
      }));
    } catch (buildError) {
      setPrepared(null);
      setError(buildError instanceof Error ? buildError.message : String(buildError));
    }
  };

  if (prepared) {
    return (
      <OpenApiImportPanel
        key={prepared.operationId}
        targetTabId={targetTabId}
        initialSource={prepared}
        heading="수동 Tool Contract 등록"
        sourceWarnings={prepared.warnings}
        onEditSource={() => setPrepared(null)}
        onDismiss={onDismiss}
      />
    );
  }

  return (
    <div
      className="max-h-[70vh] overflow-y-auto border-b border-gray-200 bg-gray-50 px-3 py-2"
      data-testid="manual-tool-contract-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-medium text-gray-700">수동 Tool Contract</div>
          <div className="text-[9px] text-gray-400">실제 token이나 request/response 값은 입력하지 않습니다.</div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[10px] text-gray-400 hover:text-gray-600"
        >
          닫기
        </button>
      </div>

      <div className="mb-2 grid grid-cols-[82px_minmax(0,1fr)] gap-1.5">
        <select
          value={method}
          onChange={(event) => setMethod(event.target.value as ManualHttpMethod)}
          className={fieldClass}
          aria-label="HTTP method"
        >
          {METHODS.map((value) => <option key={value}>{value}</option>)}
        </select>
        <input
          type="url"
          value={endpointUrl}
          onChange={(event) => setEndpointUrl(event.target.value)}
          placeholder="https://api.example.com/orders/{orderId}"
          className={fieldClass}
          data-testid="manual-endpoint-input"
        />
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <input
          value={operationId}
          onChange={(event) => setOperationId(event.target.value)}
          placeholder="operationId (자동 생성 가능)"
          maxLength={200}
          className={fieldClass}
        />
        <input
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="언제 쓰는 도구인지 한 줄 설명"
          maxLength={300}
          className={fieldClass}
          data-testid="manual-summary-input"
        />
      </div>
      <textarea
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="상세 설명 (선택)"
        maxLength={2_000}
        rows={2}
        className={`${fieldClass} mb-2 w-full resize-y`}
      />

      <div className="mb-2 border-t border-gray-200 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium text-gray-700">Parameters</span>
          <button
            type="button"
            onClick={addParameter}
            className="text-[10px] text-blue-600 hover:text-blue-700"
          >
            + parameter
          </button>
        </div>
        {parameters.length === 0 ? (
          <div className="text-[9px] text-gray-400">
            URL의 {'{pathParameter}'}는 자동으로 required string으로 추가됩니다.
          </div>
        ) : (
          <div className="space-y-1">
            {parameters.map((parameter) => (
              <div
                key={parameter.id}
                className="grid grid-cols-[minmax(0,1fr)_72px_68px_28px_20px] items-center gap-1"
              >
                <input
                  value={parameter.name}
                  onChange={(event) => updateParameter(parameter.id, { name: event.target.value })}
                  placeholder="이름"
                  className={fieldClass}
                  aria-label={`parameter ${parameter.id} 이름`}
                />
                <select
                  value={parameter.location}
                  onChange={(event) => updateParameter(parameter.id, {
                    location: event.target.value as ManualParameterLocation,
                    required: event.target.value === 'path' ? true : parameter.required,
                  })}
                  className={fieldClass}
                  aria-label={`parameter ${parameter.id} 위치`}
                >
                  {LOCATIONS.map((value) => <option key={value}>{value}</option>)}
                </select>
                <select
                  value={parameter.schemaType}
                  onChange={(event) => updateParameter(parameter.id, {
                    schemaType: event.target.value as ManualSchemaType,
                  })}
                  className={fieldClass}
                  aria-label={`parameter ${parameter.id} 타입`}
                >
                  {SCHEMA_TYPES.map((value) => <option key={value}>{value}</option>)}
                </select>
                <label className="flex justify-center" title="required">
                  <input
                    type="checkbox"
                    checked={parameter.location === 'path' || Boolean(parameter.required)}
                    disabled={parameter.location === 'path'}
                    onChange={(event) => updateParameter(parameter.id, {
                      required: event.target.checked,
                    })}
                    aria-label={`parameter ${parameter.id} 필수`}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setParameters((rows) => (
                    rows.filter((row) => row.id !== parameter.id)
                  ))}
                  className="text-sm leading-none text-gray-400 hover:text-red-500"
                  title="parameter 삭제"
                  aria-label={`parameter ${parameter.id} 삭제`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5 border-t border-gray-200 pt-2">
        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-medium text-gray-700">
            Request JSON Schema
          </span>
          <textarea
            value={requestSchemaText}
            onChange={(event) => setRequestSchemaText(event.target.value)}
            placeholder={'{"type":"object","properties":{...}}'}
            rows={6}
            spellCheck={false}
            className={`${fieldClass} w-full resize-y font-mono`}
            data-testid="manual-request-schema"
          />
          <input
            value={requestContentType}
            onChange={(event) => setRequestContentType(event.target.value)}
            aria-label="request content type"
            className={`${fieldClass} mt-1 w-full font-mono`}
          />
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-[10px] font-medium text-gray-700">
            Response JSON Schema
          </span>
          <textarea
            value={responseSchemaText}
            onChange={(event) => setResponseSchemaText(event.target.value)}
            placeholder={'{"type":"object","properties":{...}}'}
            rows={6}
            spellCheck={false}
            className={`${fieldClass} w-full resize-y font-mono`}
            data-testid="manual-response-schema"
          />
          <div className="mt-1 grid grid-cols-[58px_minmax(0,1fr)] gap-1">
            <input
              value={responseStatus}
              onChange={(event) => setResponseStatus(event.target.value)}
              aria-label="response status"
              className={`${fieldClass} font-mono`}
            />
            <input
              value={responseContentType}
              onChange={(event) => setResponseContentType(event.target.value)}
              aria-label="response content type"
              className={`${fieldClass} min-w-0 font-mono`}
            />
          </div>
        </label>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5 border-t border-gray-200 pt-2">
        <label>
          <span className="mb-1 block text-[10px] font-medium text-gray-700">인증 요구사항</span>
          <select
            value={authType}
            onChange={(event) => {
              const next = event.target.value as ManualAuthType;
              setAuthType(next);
              setAuthName(authNamePlaceholder(next));
            }}
            className={`${fieldClass} w-full`}
          >
            {AUTH_TYPES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {(authType === 'apiKeyHeader' || authType === 'apiKeyQuery' || authType === 'cookie') ? (
          <label>
            <span className="mb-1 block text-[10px] font-medium text-gray-700">
              이름
            </span>
            <input
              value={authName}
              onChange={(event) => setAuthName(event.target.value)}
              placeholder={authNamePlaceholder(authType)}
              className={`${fieldClass} w-full`}
            />
          </label>
        ) : (
          <div className="self-end pb-1 text-[9px] text-gray-400">
            인증 실제 값은 Collection의 auth profile에서 해석합니다.
          </div>
        )}
      </div>

      {error && (
        <div className="mb-2 bg-red-50 px-2 py-1.5 text-[10px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-[9px] text-gray-400">
          다음 단계에서 XGEN readiness 결과를 확인한 뒤 등록합니다.
        </span>
        <button
          type="button"
          onClick={buildSource}
          className="bg-blue-600 px-2 py-1.5 text-[10px] text-white hover:bg-blue-700"
        >
          contract 검증
        </button>
      </div>
    </div>
  );
}
