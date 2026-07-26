export type PermissionReadinessReason =
  | 'ready'
  | 'unsupported_url'
  | 'host_permission_required'
  | 'cookie_permission_required';

export interface PermissionReadiness {
  ready: boolean;
  reason: PermissionReadinessReason;
  originPattern?: string;
  originPatterns?: string[];
  missingOriginPatterns?: string[];
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
  return requestHostPermissions([url]);
}

export async function requestHostPermissions(
  urls: Array<string | undefined>,
): Promise<PermissionReadiness> {
  const originPatterns = [...new Set(
    urls
      .map((url) => originPatternForUrl(url))
      .filter((pattern): pattern is string => Boolean(pattern)),
  )];
  const originPattern = originPatterns[0];
  if (!originPattern) return inspectHostPermission(urls[0]);
  let topFrameGranted = await chrome.permissions.contains({
    origins: [originPattern],
  });
  if (!topFrameGranted) {
    topFrameGranted = await chrome.permissions.request({
      origins: [originPattern],
    });
  }
  if (!topFrameGranted) {
    return {
      ready: false,
      reason: 'host_permission_required',
      originPattern,
      originPatterns,
      missingOriginPatterns: [originPattern],
      hostPermission: false,
      cookiePermission: await chrome.permissions.contains({
        permissions: ['cookies'],
      }),
    };
  }

  const optionalFramePatterns = originPatterns.slice(1);
  const missingOptionalPatterns: string[] = [];
  for (const pattern of optionalFramePatterns) {
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      missingOptionalPatterns.push(pattern);
    }
  }
  if (missingOptionalPatterns.length > 0) {
    await chrome.permissions.request({
      origins: missingOptionalPatterns,
    }).catch(() => false);
  }
  const stillMissingOptionalPatterns: string[] = [];
  for (const pattern of missingOptionalPatterns) {
    if (!await chrome.permissions.contains({ origins: [pattern] })) {
      stillMissingOptionalPatterns.push(pattern);
    }
  }

  return {
    ready: true,
    reason: 'ready',
    originPattern,
    originPatterns,
    missingOriginPatterns: stillMissingOptionalPatterns,
    hostPermission: true,
    cookiePermission: await chrome.permissions.contains({
      permissions: ['cookies'],
    }),
  };
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
