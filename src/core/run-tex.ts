import { dvi2html } from '@drgrice1/dvi2html';
import pako from 'pako';
import { Buffer } from 'buffer';
import * as library from './library';

export interface TexDataset {
	tikzLibraries?: string;
	texPackages?: string;
	addToPreamble?: string;
	showConsole?: boolean;
}

let coredump: Uint8Array | null = null;
let code: Uint8Array | null = null;
let wasmModule: WebAssembly.Module | null = null;
let resourcesBaseUrl = '';
let loaded = false;
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@drgrice1/tikzjax@1.0.0-beta24/dist';
const RESOURCE_CACHE_MAX_ENTRIES = 256;
const MISSING_LOCAL_RESOURCES_MAX_ENTRIES = 512;
const resourceCache = new Map<string, Promise<Uint8Array>>();
const missingLocalResourceFiles = new Set<string>();

const touchResourceCache = (url: string, value: Promise<Uint8Array>) => {
	if (resourceCache.has(url)) {
		resourceCache.delete(url);
	}

	resourceCache.set(url, value);

	while (resourceCache.size > RESOURCE_CACHE_MAX_ENTRIES) {
		const oldestKey = resourceCache.keys().next().value;
		if (!oldestKey) break;
		resourceCache.delete(oldestKey);
	}
};

const rememberMissingLocalResource = (relativeFile: string) => {
	if (missingLocalResourceFiles.has(relativeFile)) {
		return;
	}

	missingLocalResourceFiles.add(relativeFile);

	while (missingLocalResourceFiles.size > MISSING_LOCAL_RESOURCES_MAX_ENTRIES) {
		const oldestMissing = missingLocalResourceFiles.values().next().value;
		if (!oldestMissing) break;
		missingLocalResourceFiles.delete(oldestMissing);
	}
};

const loadDecompress = async (url: string): Promise<Uint8Array> => {
    const response = await fetch(url);
    if (response.ok) {
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error(`Unable to read ${url}. Response body is empty.`);
        }
        const inflate = new pako.Inflate();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            inflate.push(value);
        }
        reader.releaseLock();
        if (inflate.err) throw new Error(inflate.msg ?? String(inflate.err));

        return inflate.result as Uint8Array;
    } else {
        throw new Error(`Unable to load ${url}. File not available.`);
    }
};

const loadDecompressCached = async (url: string): Promise<Uint8Array> => {
	const cached = resourceCache.get(url);
	if (cached) {
		touchResourceCache(url, cached);
		return cached;
	}

	const loader = loadDecompress(url).catch((error) => {
		resourceCache.delete(url);
		throw error;
	});

	touchResourceCache(url, loader);
	return loader;
};

export async function loadTexEngine(urlRoot: string): Promise<void> {
	if (loaded && resourcesBaseUrl === urlRoot) {
		return;
	}

	resourcesBaseUrl = urlRoot.replace(/\/$/, '');
	resourceCache.clear();
	missingLocalResourceFiles.clear();

	code = await loadDecompressCached(`${resourcesBaseUrl}/tex.wasm.gz`);
	const coreDumpRaw = await loadDecompressCached(`${resourcesBaseUrl}/core.dump.gz`);
	coredump = coreDumpRaw.slice(0, library.pages * 65536);
	wasmModule = await WebAssembly.compile(code as unknown as BufferSource);
	loaded = true;
}

export async function texify(input: string, dataset: TexDataset): Promise<string> {
	if (!loaded || !code || !coredump) {
		throw new Error('TeX engine has not been loaded.');
	}

	const texPackages = dataset.texPackages ? JSON.parse(dataset.texPackages) : {};

	const packageBlock = Object.entries(texPackages)
		.map(([pkg, option]) => `\\usepackage${option ? `[${option}]` : ''}{${pkg}}`)
		.join('\n');
	const libraryBlock = dataset.tikzLibraries ? `\\usetikzlibrary{${dataset.tikzLibraries}}` : '';
	const customPreamble = dataset.addToPreamble?.trim() ?? '';

	const hasUsePackage = /\\usepackage(?:\[[^\]]*\])?\{[^}]+\}/.test(input);
	const hasUseTikzLibrary = /\\usetikzlibrary(?:\[[^\]]*\])?\{[^}]+\}/.test(input);
	const hasBeginDocument = /\\begin\{document\}/.test(input);
	const hasEndDocument = /\\end\{document\}/.test(input);

	const preambleChunks: string[] = [];
	if (packageBlock && !hasUsePackage) preambleChunks.push(packageBlock);
	if (libraryBlock && !hasUseTikzLibrary) preambleChunks.push(libraryBlock);
	if (customPreamble && !input.includes(customPreamble)) preambleChunks.push(customPreamble);

	const preambleText = preambleChunks.join('\n').trim();

	if (hasBeginDocument) {
		if (preambleText) {
			input = input.replace(/\\begin\{document\}/, `${preambleText}\n\\begin{document}`);
		}
		if (!hasEndDocument) {
			input = `${input}\n\\end{document}\n`;
		}
	} else {
		input = `${preambleText ? `${preambleText}\n` : ''}\\begin{document}\n${input}\n\\end{document}\n`;
	}

	if (dataset.showConsole) library.setShowConsole();

	library.writeFileSync('input.tex', Buffer.from(input));

	const memory = new WebAssembly.Memory({ initial: library.pages, maximum: library.pages });
	const buffer = new Uint8Array(memory.buffer, 0, library.pages * 65536);
	buffer.set(coredump);

	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');
	library.setFileLoader(async (relativeFile: string) => {
		if (!missingLocalResourceFiles.has(relativeFile)) {
			try {
				return await loadDecompressCached(`${resourcesBaseUrl}/${relativeFile}`);
			} catch {
				rememberMissingLocalResource(relativeFile);
			}
		}

		return await loadDecompressCached(`${CDN_BASE}/${relativeFile}`);
	});

	if (!wasmModule) {
		wasmModule = await WebAssembly.compile(code as unknown as BufferSource);
	}

	const wasmInstance = await WebAssembly.instantiate(wasmModule, { library, env: { memory } });

	await library.executeAsync(wasmInstance.exports as WebAssembly.Exports & { main: () => void });

	const dvi = library.readFileSync('input.dvi');
	library.deleteEverything();

	let html = '';
	const page = {
		write(chunk: Uint8Array | string) {
			html += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
			return true;
		},
		end() {
			/* no-op */
		},
	};

	const streamBuffer = {
		[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
			let emitted = false;
			return {
				next: async () => {
					if (emitted) {
						return { done: true, value: undefined as unknown as Uint8Array };
					}
					emitted = true;
					return { done: false, value: Buffer.from(dvi) };
				},
			};
		},
	};

	await dvi2html(streamBuffer as any, page as any);

	return html;
}
