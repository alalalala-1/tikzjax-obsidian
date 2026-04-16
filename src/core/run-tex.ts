import { dvi2html, dviParser, mergeText, specials, execute, Machines } from '@drgrice1/dvi2html';
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

const TEX_LOG_ERROR_LOOKAHEAD_LINES = 4;
const TEX_LOG_TAIL_LINES = 20;
const DVI_RECENT_OPS_LIMIT = 24;
const DVI_CHAR_EVENTS_LIMIT = 16;
const DVI_CONVERT_LOG_TAIL_LINES = 30;
const metric127FallbackNotified = new Set<string>();

interface DviCharEvent {
	offset: number;
	page: number;
	opcode: number;
	charCode: number;
	kind: 'set' | 'put';
	fontId: number | null;
	fontName: string | null;
}

interface DviInspectionResult {
	pageCount: number;
	currentFontId: number | null;
	currentFontName: string | null;
	knownFonts: string[];
	char127Events: DviCharEvent[];
	recentOps: string[];
	parseWarning: string | null;
}

interface DviConversionFallbackResult {
	patchedFontContexts: string[];
}

const toUtf8String = (value: Uint8Array | string): string => {
	if (typeof value === 'string') return value;
	return Buffer.from(value).toString('utf8');
};

const summarizeTexLogError = (logText: string): string | null => {
	const lines = logText.replace(/\r\n/g, '\n').split('\n');
	const errorIndex = lines.findIndex((line) => line.trimStart().startsWith('!'));
	if (errorIndex < 0) {
		return null;
	}

	const headline = lines[errorIndex].replace(/^\s*!\s*/, '').trim();
	let location = '';
	for (let i = errorIndex + 1; i <= Math.min(lines.length - 1, errorIndex + TEX_LOG_ERROR_LOOKAHEAD_LINES); i++) {
		const candidate = lines[i].trim();
		if (/^l\.\d+/.test(candidate)) {
			location = candidate;
			break;
		}
	}

	if (headline && location) {
		return `${headline} (${location})`;
	}

	return headline || null;
};

const texLogTail = (logText: string, maxLines = TEX_LOG_TAIL_LINES): string => {
	const lines = logText
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);

	if (lines.length === 0) return '';
	return lines.slice(-maxLines).join('\n');
};

const pushLimited = <T>(target: T[], value: T, maxEntries: number) => {
	target.push(value);
	if (target.length > maxEntries) {
		target.splice(0, target.length - maxEntries);
	}
};

const readUIntBE = (bytes: Uint8Array, offset: number, width: number): number => {
	let value = 0;
	for (let i = 0; i < width; i++) {
		value = (value << 8) | bytes[offset + i];
	}
	return value >>> 0;
};

const dviOpcodeName = (opcode: number): string => {
	if (opcode >= 0 && opcode <= 127) return `set_char_${opcode}`;
	if (opcode >= 171 && opcode <= 234) return `fnt_num_${opcode - 171}`;

	switch (opcode) {
		case 128:
			return 'set1';
		case 129:
			return 'set2';
		case 130:
			return 'set3';
		case 131:
			return 'set4';
		case 132:
			return 'set_rule';
		case 133:
			return 'put1';
		case 134:
			return 'put2';
		case 135:
			return 'put3';
		case 136:
			return 'put4';
		case 137:
			return 'put_rule';
		case 138:
			return 'nop';
		case 139:
			return 'bop';
		case 140:
			return 'eop';
		case 141:
			return 'push';
		case 142:
			return 'pop';
		case 143:
			return 'right1';
		case 144:
			return 'right2';
		case 145:
			return 'right3';
		case 146:
			return 'right4';
		case 147:
			return 'w0';
		case 148:
			return 'w1';
		case 149:
			return 'w2';
		case 150:
			return 'w3';
		case 151:
			return 'w4';
		case 152:
			return 'x0';
		case 153:
			return 'x1';
		case 154:
			return 'x2';
		case 155:
			return 'x3';
		case 156:
			return 'x4';
		case 157:
			return 'down1';
		case 158:
			return 'down2';
		case 159:
			return 'down3';
		case 160:
			return 'down4';
		case 161:
			return 'y0';
		case 162:
			return 'y1';
		case 163:
			return 'y2';
		case 164:
			return 'y3';
		case 165:
			return 'y4';
		case 166:
			return 'z0';
		case 167:
			return 'z1';
		case 168:
			return 'z2';
		case 169:
			return 'z3';
		case 170:
			return 'z4';
		case 235:
			return 'fnt1';
		case 236:
			return 'fnt2';
		case 237:
			return 'fnt3';
		case 238:
			return 'fnt4';
		case 239:
			return 'xxx1';
		case 240:
			return 'xxx2';
		case 241:
			return 'xxx3';
		case 242:
			return 'xxx4';
		case 243:
			return 'fnt_def1';
		case 244:
			return 'fnt_def2';
		case 245:
			return 'fnt_def3';
		case 246:
			return 'fnt_def4';
		case 247:
			return 'pre';
		case 248:
			return 'post';
		case 249:
			return 'post_post';
		default:
			return `opcode_${opcode}`;
	}
};

const createSingleChunkDviStream = (dvi: Uint8Array) => ({
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
});

const convertDviWithMissingMetric127Fallback = async (
	dvi: Uint8Array,
	page: { write: (chunk: Uint8Array | string) => boolean; end: () => void },
): Promise<DviConversionFallbackResult> => {
	const HtmlMachineCtor = (Machines as any)?.HTML;
	if (!HtmlMachineCtor) {
		throw new Error('dvi2html fallback unavailable: Machines.HTML missing.');
	}

	class Metric127FallbackMachine extends HtmlMachineCtor {
		patchedFontContexts = new Set<string>();

		putText(chunk: Uint8Array | string) {
			const values =
				typeof chunk === 'string'
					? Uint8Array.from(chunk.split('').map((ch) => ch.charCodeAt(0) & 0xff))
					: chunk;

			let hasChar127 = false;
			for (const charCode of values) {
				if (charCode === 127) {
					hasChar127 = true;
					break;
				}
			}

			if (hasChar127) {
				const font = (this as any).font;
				const chars: Map<number, unknown> | undefined = font?.metrics?.characters;
				if (chars && chars.get(127) === undefined) {
					const fallbackMetric = chars.get(126) ?? chars.get(63) ?? Array.from(chars.values()).at(-1);
					if (fallbackMetric !== undefined) {
						chars.set(127, fallbackMetric);
						const fontName = font?.name ?? 'unknown-font';
						this.patchedFontContexts.add(`${fontName}:127<=${chars.get(126) !== undefined ? '126' : chars.get(63) !== undefined ? '63' : 'last'}`);
					}
				}
			}

			return super.putText(chunk);
		}
	}

	const pipeline = (specials as any).papersize(
		(specials as any).svg(
			(specials as any).color(
				(mergeText as any)((dviParser as any)(createSingleChunkDviStream(dvi))),
			),
		),
	);
	const machine = new Metric127FallbackMachine(page as any);
	await (execute as any)(pipeline, machine);

	return {
		patchedFontContexts: Array.from(machine.patchedFontContexts),
	};
};

const inspectDvi = (bytes: Uint8Array): DviInspectionResult => {
	const length = bytes.length;
	const fontNames = new Map<number, string>();
	const recentOps: string[] = [];
	const char127Events: DviCharEvent[] = [];

	let cursor = 0;
	let page = 0;
	let currentFont: number | null = null;
	let parseWarning: string | null = null;

	const hasBytes = (count: number) => cursor + count <= length;
	const fontNameFor = (fontId: number | null): string | null => {
		if (fontId === null) return null;
		return fontNames.get(fontId) ?? null;
	};

	const recordOp = (offset: number, opcode: number, details?: string) => {
		const line = `${offset}: ${dviOpcodeName(opcode)}${details ? ` ${details}` : ''}`;
		pushLimited(recentOps, line, DVI_RECENT_OPS_LIMIT);
	};

	const recordChar = (offset: number, opcode: number, kind: 'set' | 'put', charCode: number) => {
		recordOp(offset, opcode, `char=${charCode}${currentFont !== null ? ` font=${currentFont}` : ''}`);
		if (charCode === 127) {
			pushLimited(
				char127Events,
				{
					offset,
					page,
					opcode,
					charCode,
					kind,
					fontId: currentFont,
					fontName: fontNameFor(currentFont),
				},
				DVI_CHAR_EVENTS_LIMIT,
			);
		}
	};

	while (cursor < length) {
		const offset = cursor;
		const opcode = bytes[cursor++];

		if (opcode <= 127) {
			recordChar(offset, opcode, 'set', opcode);
			continue;
		}

		if (opcode >= 171 && opcode <= 234) {
			currentFont = opcode - 171;
			recordOp(offset, opcode, `font=${currentFont}${fontNameFor(currentFont) ? `(${fontNameFor(currentFont)})` : ''}`);
			continue;
		}

		switch (opcode) {
			case 128:
			case 129:
			case 130:
			case 131: {
				const width = opcode - 127;
				if (!hasBytes(width)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)}.`;
					cursor = length;
					break;
				}
				const charCode = readUIntBE(bytes, cursor, width);
				cursor += width;
				recordChar(offset, opcode, 'set', charCode);
				break;
			}
			case 132:
			case 137: {
				if (!hasBytes(8)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)} payload.`;
					cursor = length;
					break;
				}
				cursor += 8;
				recordOp(offset, opcode);
				break;
			}
			case 133:
			case 134:
			case 135:
			case 136: {
				const width = opcode - 132;
				if (!hasBytes(width)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)}.`;
					cursor = length;
					break;
				}
				const charCode = readUIntBE(bytes, cursor, width);
				cursor += width;
				recordChar(offset, opcode, 'put', charCode);
				break;
			}
			case 138:
			case 140:
			case 141:
			case 142:
			case 147:
			case 152:
			case 161:
			case 166:
				recordOp(offset, opcode);
				break;
			case 139:
				if (!hasBytes(44)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading bop payload.`;
					cursor = length;
					break;
				}
				page += 1;
				cursor += 44;
				recordOp(offset, opcode, `page=${page}`);
				break;
			case 143:
			case 144:
			case 145:
			case 146:
			case 148:
			case 149:
			case 150:
			case 151:
			case 153:
			case 154:
			case 155:
			case 156:
			case 157:
			case 158:
			case 159:
			case 160:
			case 162:
			case 163:
			case 164:
			case 165:
			case 167:
			case 168:
			case 169:
			case 170: {
				const widthByOpcode: Record<number, number> = {
					143: 1,
					144: 2,
					145: 3,
					146: 4,
					148: 1,
					149: 2,
					150: 3,
					151: 4,
					153: 1,
					154: 2,
					155: 3,
					156: 4,
					157: 1,
					158: 2,
					159: 3,
					160: 4,
					162: 1,
					163: 2,
					164: 3,
					165: 4,
					167: 1,
					168: 2,
					169: 3,
					170: 4,
				};
				const width = widthByOpcode[opcode] ?? 0;
				if (!hasBytes(width)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)} payload.`;
					cursor = length;
					break;
				}
				cursor += width;
				recordOp(offset, opcode);
				break;
			}
			case 235:
			case 236:
			case 237:
			case 238: {
				const width = opcode - 234;
				if (!hasBytes(width)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)}.`;
					cursor = length;
					break;
				}
				currentFont = readUIntBE(bytes, cursor, width);
				cursor += width;
				recordOp(offset, opcode, `font=${currentFont}${fontNameFor(currentFont) ? `(${fontNameFor(currentFont)})` : ''}`);
				break;
			}
			case 239:
			case 240:
			case 241:
			case 242: {
				const lenWidth = opcode - 238;
				if (!hasBytes(lenWidth)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)} length.`;
					cursor = length;
					break;
				}
				const payloadLength = readUIntBE(bytes, cursor, lenWidth);
				cursor += lenWidth;
				if (!hasBytes(payloadLength)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)} payload.`;
					cursor = length;
					break;
				}
				cursor += payloadLength;
				recordOp(offset, opcode, `len=${payloadLength}`);
				break;
			}
			case 243:
			case 244:
			case 245:
			case 246: {
				const keyWidth = opcode - 242;
				if (!hasBytes(keyWidth + 14)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading ${dviOpcodeName(opcode)} header.`;
					cursor = length;
					break;
				}
				const fontId = readUIntBE(bytes, cursor, keyWidth);
				cursor += keyWidth;
				cursor += 12;
				const areaLength = bytes[cursor++];
				const nameLength = bytes[cursor++];
				const totalNameLength = areaLength + nameLength;
				if (!hasBytes(totalNameLength)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading font name.`;
					cursor = length;
					break;
				}
				const fontName = Buffer.from(bytes.subarray(cursor, cursor + totalNameLength)).toString('latin1').replace(/\0/g, '');
				cursor += totalNameLength;
				fontNames.set(fontId, fontName);
				recordOp(offset, opcode, `font=${fontId} name=${fontName}`);
				break;
			}
			case 247: {
				if (!hasBytes(14)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading preamble.`;
					cursor = length;
					break;
				}
				const commentLength = bytes[cursor + 13];
				if (!hasBytes(14 + commentLength)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading preamble comment.`;
					cursor = length;
					break;
				}
				cursor += 14 + commentLength;
				recordOp(offset, opcode, `commentLen=${commentLength}`);
				break;
			}
			case 248:
				if (!hasBytes(28)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading postamble.`;
					cursor = length;
					break;
				}
				cursor += 28;
				recordOp(offset, opcode);
				break;
			case 249:
				if (!hasBytes(5)) {
					parseWarning = `Truncated DVI at offset ${offset} while reading post_post.`;
					cursor = length;
					break;
				}
				cursor += 5;
				while (cursor < length && bytes[cursor] === 223) {
					cursor += 1;
				}
				recordOp(offset, opcode);
				break;
			default:
				parseWarning = `Unsupported/unknown DVI opcode ${opcode} at offset ${offset}.`;
				recordOp(offset, opcode);
				cursor = length;
				break;
		}
	}

	const knownFonts = Array.from(fontNames.entries()).map(([id, name]) => `${id}:${name}`).slice(0, 24);

	return {
		pageCount: page,
		currentFontId: currentFont,
		currentFontName: fontNameFor(currentFont),
		knownFonts,
		char127Events,
		recentOps,
		parseWarning,
	};
};

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

	let dvi!: Uint8Array;
	let compileLog = '';
	try {
		await library.executeAsync(wasmInstance.exports as WebAssembly.Exports & { main: () => void });

		try {
			const rawLog = library.readFileSync('input.log');
			compileLog = toUtf8String(rawLog);
		} catch {
			/* ignore missing log file */
		}

		dvi = library.readFileSync('input.dvi');
	} catch (error) {
		if (!compileLog) {
			try {
				const rawLog = library.readFileSync('input.log');
				compileLog = toUtf8String(rawLog);
			} catch {
				/* ignore missing log file */
			}
		}

		let rawMessage = error instanceof Error ? error.message : String(error);
		const logSummary = compileLog ? summarizeTexLogError(compileLog) : null;
		if (logSummary) {
			throw new Error(`TeX compile failed: ${logSummary}`);
		}

		if (compileLog) {
			const tail = texLogTail(compileLog);
			if (tail) {
				throw new Error(`TeX compile failed: ${rawMessage}\n${tail}`);
			}
		}

		throw new Error(`TeX compile failed: ${rawMessage}`);
	} finally {
		library.deleteEverything();
	}

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

	try {
		await dvi2html(createSingleChunkDviStream(dvi) as any, page as any);
	} catch (error) {
		let rawMessage = error instanceof Error ? error.message : String(error);
		const inspection = inspectDvi(dvi);
		const shouldTryMetric127Fallback = /Could not find font metric for 127/.test(rawMessage);

		if (shouldTryMetric127Fallback) {
			try {
				html = '';
				const fallbackResult = await convertDviWithMissingMetric127Fallback(dvi, page);
				if (fallbackResult.patchedFontContexts.length > 0) {
					const notifyKey = fallbackResult.patchedFontContexts.slice().sort().join('|');
					if (!metric127FallbackNotified.has(notifyKey)) {
						metric127FallbackNotified.add(notifyKey);
						console.info('[TikzJax] dvi2html metric-127 fallback applied', {
							fonts: fallbackResult.patchedFontContexts,
							dviBytes: dvi.byteLength,
						});
					}
				}
				return html;
			} catch (fallbackError) {
				const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
				console.error('[TikzJax] metric-127 fallback failed', fallbackError);
				// keep original failure path, but include fallback failure in diagnostics below
				rawMessage += `\nFallback conversion attempt failed: ${fallbackMessage}`;
			}
		}

		const diagnosticLines: string[] = [
			`DVI conversion failed: ${rawMessage}`,
			`DVI bytes: ${dvi.byteLength}`,
			`DVI pages detected: ${inspection.pageCount}`,
			`Resources base: ${resourcesBaseUrl}`,
			`CDN fallback: ${CDN_BASE}`,
		];

		if (inspection.currentFontId !== null) {
			diagnosticLines.push(
				`Current font at failure tail: ${inspection.currentFontId}${
					inspection.currentFontName ? ` (${inspection.currentFontName})` : ''
				}`,
			);
		}

		if (inspection.char127Events.length > 0) {
			diagnosticLines.push(
				'char=127 events:\n' +
					inspection.char127Events
						.map(
							(event) =>
								`  offset=${event.offset}, page=${event.page}, opcode=${dviOpcodeName(event.opcode)}, kind=${event.kind}, font=${
									event.fontId !== null ? `${event.fontId}${event.fontName ? `(${event.fontName})` : ''}` : 'null'
								}`,
						)
						.join('\n'),
			);
		}

		if (inspection.knownFonts.length > 0) {
			diagnosticLines.push(`Fonts seen in DVI: ${inspection.knownFonts.join(', ')}`);
		}

		if (inspection.recentOps.length > 0) {
			diagnosticLines.push('Recent DVI ops:\n' + inspection.recentOps.map((line) => `  ${line}`).join('\n'));
		}

		if (inspection.parseWarning) {
			diagnosticLines.push(`DVI parse warning: ${inspection.parseWarning}`);
		}

		if (missingLocalResourceFiles.size > 0) {
			const missingFiles = Array.from(missingLocalResourceFiles).slice(0, 12);
			diagnosticLines.push(
				`Missing local resources observed: ${missingFiles.join(', ')}${
					missingLocalResourceFiles.size > missingFiles.length
						? ` (+${missingLocalResourceFiles.size - missingFiles.length} more)`
						: ''
				}`,
			);
		}

		if (compileLog) {
			const tail = texLogTail(compileLog, DVI_CONVERT_LOG_TAIL_LINES);
			if (tail) {
				diagnosticLines.push(`TeX log tail:\n${tail}`);
			}
		}

		if (error instanceof Error && error.stack) {
			diagnosticLines.push(`Stack:\n${error.stack}`);
		}

		throw new Error(diagnosticLines.join('\n'));
	}

	return html;
}
