export type PermissionReadinessReason =
  | 'ready'
  | 'unsupported_url'
  | 'host_permission_required'
  | 'cookie_permission_required';

export interface PermissionReadiness {
  ready: boolean;
  reason: PermissionReadinessReason;
  originPattern?: string;
  hostPermission: boolean;
  cookiePermission: boolean;
}

export function originPatternForUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export async function inspectHostPermission(
  url: string | undefined,
): Promise<PermissionReadiness> {
  const originPattern = originPatternForUrl(url);
  if (!originPattern) {
    return {
      ready: false,
      reason: 'unsupported_url',
      hostPermission: false,
      cookiePermission: false,
    };
  }
  const [hostPermission, cookiePermission] = await Promise.all([
    chrome.permissions.contains({ origins: [originPattern] }),
    chrome.permissions.contains({ permissions: ['cookies'] }),
  ]);
  return {
    ready: hostPermission,
    reason: hostPermission ? 'ready' : 'host_permission_required',
    originPattern,
    hostPermission,
    cookiePermission,
  };
}

export async function inspectCookiePermission(
  url: string | undefined,
): Promise<PermissionReadiness> {
  const readiness = await inspectHostPermission(url);
  if (!readiness.hostPermission) return readiness;
  return {
    ...readiness,
    ready: readiness.cookiePermission,
    reason: readiness.cookiePermission ? 'ready' : 'cookie_permission_required',
  };
}

export async function requestHostPermission(
  url: string | undefined,
): Promise<PermissionReadiness> {
  const originPattern = originPatternForUrl(url);
  if (!originPattern) return inspectHostPermission(url);
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    return {
      ready: false,
      reason: 'host_permission_required',
      originPattern,
      hostPermission: false,
      cookiePermission: await chrome.permissions.contains({
        permissions: ['cookies'],
      }),
    };
  }
  return inspectHostPermission(url);
}

export async function requestCookiePermission(
  url: string | undefined,
): Promise<PermissionReadiness> {
  const originPattern = originPatternForUrl(url);
  if (!originPattern) return inspectCookiePermission(url);
  const granted = await chrome.permissions.request({
    permissions: ['cookies'],
    origins: [originPattern],
  });
  if (!granted) return inspectCookiePermission(url);
  return inspectCookiePermission(url);
}
