/// <reference lib="webworker" />

import { loadTexEngine, texify } from './core/run-tex';
import type { TikzRenderInput } from './types';

declare const self: DedicatedWorkerGlobalScope;

type InitMessage = {
	type: 'init';
	resourcesBaseUrl: string;
};

type RenderMessage = {
	type: 'render';
	id: string;
	payload: TikzRenderInput;
};

type IncomingMessage = InitMessage | RenderMessage;

let initPromise: Promise<void> | null = null;

globalThis.__tikzConsoleWriter = (message: string) => {
	self.postMessage({ type: 'console', message });
};

const ensureInitialized = async (resourcesBaseUrl?: string) => {
	if (!initPromise) {
		if (!resourcesBaseUrl) {
			throw new Error('Worker not initialized.');
		}
		initPromise = loadTexEngine(resourcesBaseUrl);
	}
	await initPromise;
};

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') return;

	try {
		if (message.type === 'init') {
			await ensureInitialized(message.resourcesBaseUrl);
			self.postMessage({ type: 'ready' });
			return;
		}

		if (message.type === 'render') {
			await ensureInitialized();
			const payload = message.payload;
			const html = await texify(payload.source, {
				tikzLibraries: payload.libraries,
				texPackages: payload.packages ? JSON.stringify(payload.packages) : undefined,
				addToPreamble: payload.preamble,
				showConsole: payload.showConsole,
			});

			self.postMessage({ type: 'result', id: message.id, html });
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (message.type === 'render') {
			self.postMessage({ type: 'error', id: message.id, message: msg });
		} else {
			self.postMessage({ type: 'error', message: msg });
		}
	}
};

export {};
