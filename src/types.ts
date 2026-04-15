export interface TikzJaxSettings {
	cacheFolder: string;
	enableCache: boolean;
	autoLoadCache: boolean;
	autoCleanCache: boolean;
	lazyRender: boolean;
	cacheStatusLabelColor: string;
	renderTimeoutMs: number;
	showTexConsole: boolean;
}

export const DEFAULT_SETTINGS: TikzJaxSettings = {
	cacheFolder: '.tikzjax-cache',
	enableCache: true,
	autoLoadCache: true,
	autoCleanCache: false,
	lazyRender: true,
	cacheStatusLabelColor: '#c62828',
	renderTimeoutMs: 90000,
	showTexConsole: false,
};

export interface TikzCodeBlockInfo {
	source: string;
	libraries?: string;
	packages?: Record<string, string>;
	preamble?: string;
	hash: string;
}

export interface RenderResult {
	svg: string;
	fromCache: boolean;
	duration: number;
}

export interface RenderError {
	message: string;
	details?: string;
}

export interface RenderTask {
	id: string;
	info: TikzCodeBlockInfo;
	element: HTMLElement;
	resolve: (result: RenderResult) => void;
	reject: (error: RenderError) => void;
	startTime: number;
}

export interface TikzRenderInput {
	source: string;
	libraries?: string;
	packages?: Record<string, string>;
	preamble?: string;
	showConsole?: boolean;
}
