export function normalizeBase(value = '/'): string {
  const path = value.trim().replace(/^\/+|\/+$/g, '');
  if (!path) return '/';
  if (!/^[a-zA-Z0-9_/-]+$/.test(path) || path.split('/').some(p => p === '..')) {
    throw new Error('BASE_PATH must be an absolute URL path, such as /mise/.');
  }
  return `/${path}/`;
}

export function sitePath(base: string, path = ''): string {
  return `${normalizeBase(base)}${path.replace(/^\/+/, '')}`;
}
