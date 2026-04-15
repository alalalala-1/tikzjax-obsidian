import { normalizePath, Notice } from 'obsidian';
import type TikzJaxPlugin from './main';
import type { TikzRenderInput, TikzJaxSettings } from './types';

export interface RenderTelemetryEvent {
	queueWaitMs: number;
	workerDurationMs: number;
	queuedAhead: number;
	success: boolean;
	timeout: boolean;
	errorMessage?: string;
}

interface WorkerReadyMessage {
	type: 'ready';
}

interface WorkerConsoleMessage {
	type: 'console';
	message: string;
}

interface WorkerResultMessage {
	type: 'result';
	id: string;
	html: string;
}

interface WorkerErrorMessage {
	type: 'error';
	id?: string;
	message: string;
}

type WorkerMessage = WorkerReadyMessage | WorkerConsoleMessage | WorkerResultMessage | WorkerErrorMessage;

interface PendingRequest {
	resolve: (html: string) => void;
	reject: (error: Error) => void;
	timer: number;
}

export class TikzWorkerRenderer {
	private worker: Worker | null = null;
	private workerBlobUrl: string | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();
	private queueDepth = 0;
	private pending = new Map<string, PendingRequest>();
	private initReject: ((error: Error) => void) | null = null;

	constructor(
		private plugin: TikzJaxPlugin,
		private settingsGetter: () => TikzJaxSettings,
		private telemetryReporter?: (event: RenderTelemetryEvent) => void,
	) {}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = new Promise<void>((resolve, reject) => {
			this.initReject = reject;
			void this.createWorker()
				.then(() => this.onceReady(resolve, reject))
				.catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
		});

		try {
			await this.initPromise;
			this.initialized = true;
		} finally {
			this.initPromise = null;
			this.initReject = null;
		}
	}

	async render(input: TikzRenderInput, timeoutMs: number): Promise<string> {
		await this.initialize();
		const enqueuedAt = performance.now();
		const queuedAhead = this.queueDepth;
		this.queueDepth += 1;

		return new Promise<string>((resolve, reject) => {
			this.queue = this.queue
				.then(async () => {
					const renderStartedAt = performance.now();
					const queueWaitMs = renderStartedAt - enqueuedAt;
					try {
						const html = await this.renderOnce(input, timeoutMs);
						this.telemetryReporter?.({
							queueWaitMs,
							workerDurationMs: performance.now() - renderStartedAt,
							queuedAhead,
							success: true,
							timeout: false,
						});
						resolve(html);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						this.telemetryReporter?.({
							queueWaitMs,
							workerDurationMs: performance.now() - renderStartedAt,
							queuedAhead,
							success: false,
							timeout: /render timeout/i.test(err.message),
							errorMessage: err.message,
						});
						reject(err);
					} finally {
						this.queueDepth = Math.max(0, this.queueDepth - 1);
					}
				})
				.catch(() => {
					/* keep queue alive */
				});
		});
	}

	getQueueDepth(): number {
		return this.queueDepth;
	}

	destroy() {
		for (const [id, request] of this.pending.entries()) {
			window.clearTimeout(request.timer);
			request.reject(new Error('Renderer stopped.'));
			this.pending.delete(id);
		}
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.cleanupWorkerBlobUrl();
		this.initialized = false;
	}

	private onceReady(resolve: () => void, reject: (error: Error) => void) {
		const start = Date.now();
		const check = () => {
			if (this.initialized) {
				resolve();
				return;
			}

			if (!this.worker) {
				reject(new Error('Failed to create worker.'));
				return;
			}

			if (Date.now() - start > 20000) {
				reject(new Error('TikZ worker initialization timeout.'));
				return;
			}

			window.setTimeout(check, 50);
		};
		check();
	}

	private async createWorker() {
		const worker = await this.buildWorker();

		worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			if (!message || typeof message !== 'object') return;

			switch (message.type) {
				case 'ready':
					this.initialized = true;
					break;
				case 'console':
					if (this.settingsGetter().showTexConsole) {
						console.log(`[TikzJax/TeX] ${message.message}`);
					}
					break;
				case 'result': {
					const pending = this.pending.get(message.id);
					if (!pending) return;
					window.clearTimeout(pending.timer);
					pending.resolve(message.html);
					this.pending.delete(message.id);
					break;
				}
				case 'error': {
					if (message.id) {
						const pending = this.pending.get(message.id);
						if (pending) {
							window.clearTimeout(pending.timer);
							pending.reject(new Error(message.message));
							this.pending.delete(message.id);
						}
					} else if (!this.initialized && this.initReject) {
						this.initReject(new Error(message.message));
					}
					break;
				}
			}
		};

		worker.onerror = (event) => {
			const err = new Error(event.message || 'Unknown worker error');
			if (!this.initialized && this.initReject) {
				this.initReject(err);
			}
			for (const [id, request] of this.pending.entries()) {
				window.clearTimeout(request.timer);
				request.reject(err);
				this.pending.delete(id);
			}
			this.restartWorker();
		};

		this.worker = worker;

		worker.postMessage({
			type: 'init',
			resourcesBaseUrl: this.getResourcesBaseUrl(),
		});
	}

	private async renderOnce(input: TikzRenderInput, timeoutMs: number): Promise<string> {
		if (!this.worker) {
			this.restartWorker();
			await this.initialize();
		}

		if (!this.worker) {
			throw new Error('TikZ worker unavailable.');
		}

		const id = this.createId();
		return new Promise<string>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Render timeout after ${Math.round(timeoutMs / 1000)}s`));
				this.restartWorker();
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });
			this.worker?.postMessage({
				type: 'render',
				id,
				payload: input,
			});
		});
	}

	private restartWorker() {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.cleanupWorkerBlobUrl();
		this.initialized = false;
		void this.initialize().catch((error) => {
			console.error('TikzJax worker restart failed:', error);
			new Notice('TikzJax worker 重启失败，请稍后重试。');
		});
	}

	private async buildWorker(): Promise<Worker> {
		const scriptPath = normalizePath(`${this.plugin.manifest.dir}/tex-worker.js`);
		const script = await this.plugin.app.vault.adapter.read(scriptPath);
		const blob = new Blob([script], { type: 'text/javascript' });
		this.workerBlobUrl = URL.createObjectURL(blob);
		return new Worker(this.workerBlobUrl);
	}

	private cleanupWorkerBlobUrl() {
		if (!this.workerBlobUrl) return;
		URL.revokeObjectURL(this.workerBlobUrl);
		this.workerBlobUrl = null;
	}

	private getWorkerUrl(): string {
		const path = normalizePath(`${this.plugin.manifest.dir}/tex-worker.js`);
		return this.plugin.app.vault.adapter.getResourcePath(path);
	}

	private getResourcesBaseUrl(): string {
		const wasmPath = normalizePath(`${this.plugin.manifest.dir}/resources/tex.wasm.gz`);
		const wasmUrl = this.plugin.app.vault.adapter.getResourcePath(wasmPath);
		const url = new URL(wasmUrl);
		url.search = '';
		return url.toString().replace(/\/tex\.wasm\.gz$/, '');
	}

	private createId(): string {
		return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}
}
