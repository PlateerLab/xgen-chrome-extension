export interface AuthProfileSummary {
  service_id: string;
  name?: string;
  description?: string | null;
  status?: string;
}

export interface CollectionAuthSummary {
  collection_id?: string;
  domain_patterns?: string[];
  auth_profile_id?: string | null;
}

export type AuthProfileMatchStatus =
  | 'matched'
  | 'missing'
  | 'ambiguous';

export interface AuthProfileMatch {
  status: AuthProfileMatchStatus;
  authProfileId?: string;
  source?: 'collection' | 'profile';
  collectionId?: string;
  candidateIds?: string[];
}

const PATHFINDER_MANAGED_MARKER = '[pathfinder:auto]';

function hostname(value: string): string {
  const input = value.trim().toLowerCase();
  if (!input) return '';
  try {
    return new URL(input.includes('://') ? input : `https://${input}`).hostname;
  } catch {
    return input.replace(/:\d+$/, '').replace(/^\.+|\.+$/g, '');
  }
}

function patternRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function patternSpecificity(pattern: string): number {
  return pattern.length - (pattern.match(/\*/g)?.length ?? 0) * 100
    - (pattern.match(/\?/g)?.length ?? 0) * 10;
}

export function canonicalAuthServiceId(host: string): string {
  return hostname(host)
    .replace(/^www\./, '')
    .replace(/[^a-z0-9가-힣_-]/gi, '_');
}

export function jwtUserId(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = JSON.parse(globalThis.atob(padded)) as Record<string, unknown>;
    const subject = decoded.sub ?? decoded.user_id;
    const value = typeof subject === 'number' ? String(subject) : subject;
    return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function xgenAuthHeaders(token: string): Record<string, string> {
  const userId = jwtUserId(token);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(userId ? { 'X-User-ID': userId } : {}),
  };
}

export function matchCollectionAuthProfile(
  host: string,
  collections: CollectionAuthSummary[],
): AuthProfileMatch {
  const normalizedHost = hostname(host);
  const matches = collections.flatMap((collection) =>
    (collection.domain_patterns ?? [])
      .map((pattern) => pattern.trim().toLowerCase())
      .filter((pattern) => pattern && patternRegex(pattern).test(normalizedHost))
      .map((pattern) => ({
        collection,
        specificity: patternSpecificity(pattern),
      })));
  if (matches.length === 0) return { status: 'missing' };

  matches.sort((left, right) => right.specificity - left.specificity);
  const topSpecificity = matches[0].specificity;
  const top = matches.filter((match) => match.specificity === topSpecificity);
  const profileIds = [...new Set(
    top
      .map(({ collection }) => collection.auth_profile_id)
      .filter((value): value is string => Boolean(value)),
  )];
  if (profileIds.length > 1) {
    return {
      status: 'ambiguous',
      source: 'collection',
      candidateIds: profileIds,
    };
  }
  if (profileIds.length === 1) {
    const selected = top.find(
      ({ collection }) => collection.auth_profile_id === profileIds[0],
    )?.collection;
    return {
      status: 'matched',
      source: 'collection',
      authProfileId: profileIds[0],
      ...(selected?.collection_id ? { collectionId: selected.collection_id } : {}),
    };
  }
  return { status: 'missing' };
}

export function matchExactAuthProfile(
  host: string,
  profiles: AuthProfileSummary[],
): AuthProfileMatch {
  const normalizedHost = hostname(host);
  const serviceId = canonicalAuthServiceId(normalizedHost);
  const matches = profiles.filter((profile) => {
    if ((profile.status ?? 'active') !== 'active') return false;
    const name = (profile.name ?? '').trim().toLowerCase();
    return profile.service_id.toLowerCase() === serviceId.toLowerCase()
      || name === normalizedHost
      || name === `${normalizedHost} (자동 생성)`;
  });
  const ids = [...new Set(matches.map((profile) => profile.service_id))];
  if (ids.length > 1) {
    return {
      status: 'ambiguous',
      source: 'profile',
      candidateIds: ids,
    };
  }
  return ids.length === 1
    ? { status: 'matched', source: 'profile', authProfileId: ids[0] }
    : { status: 'missing' };
}

export function isPathfinderManagedProfile(
  profile: AuthProfileSummary,
  host: string,
): boolean {
  if (profile.service_id.toLowerCase() !== canonicalAuthServiceId(host).toLowerCase()) {
    return false;
  }
  const description = (profile.description ?? '').toLowerCase();
  const name = (profile.name ?? '').toLowerCase();
  const normalizedHost = hostname(host);
  return description.includes(PATHFINDER_MANAGED_MARKER)
    || name === `${normalizedHost} (자동 생성)`;
}

export { PATHFINDER_MANAGED_MARKER };
