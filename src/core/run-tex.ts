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
let resourcesBaseUrl = '';
let loaded = false;
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@drgrice1/tikzjax@1.0.0-beta24/dist';

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

export async function loadTexEngine(urlRoot: string): Promise<void> {
	if (loaded && resourcesBaseUrl === urlRoot) {
		return;
	}

	resourcesBaseUrl = urlRoot.replace(/\/$/, '');
	code = await loadDecompress(`${resourcesBaseUrl}/tex.wasm.gz`);
	const coreDumpRaw = await loadDecompress(`${resourcesBaseUrl}/core.dump.gz`);
	coredump = coreDumpRaw.slice(0, library.pages * 65536);
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
	buffer.set(coredump.slice(0));

	library.setMemory(memory.buffer);
	library.setInput('input.tex\n\\end\n');
	library.setFileLoader(async (relativeFile: string) => {
		try {
			return await loadDecompress(`${resourcesBaseUrl}/${relativeFile}`);
		} catch {
			return await loadDecompress(`${CDN_BASE}/${relativeFile}`);
		}
	});

	const wasmModule = await WebAssembly.compile(code as unknown as BufferSource);
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
