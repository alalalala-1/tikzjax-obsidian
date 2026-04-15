const PLUGIN_VERSION = '0.1.0';

export async function createHash(input: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(input + PLUGIN_VERSION);
	const hashBuffer = await crypto.subtle.digest('SHA-1', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createCacheKey(
	source: string,
	libraries?: string,
	packages?: Record<string, string>,
	preamble?: string
): string {
	const parts = [source];
	if (libraries) parts.push(`libs:${libraries}`);
	if (packages) parts.push(`pkgs:${JSON.stringify(packages)}`);
	if (preamble) parts.push(`pre:${preamble}`);
	return parts.join('|||');
}
